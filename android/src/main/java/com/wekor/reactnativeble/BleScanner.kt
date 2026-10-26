package com.wekor.reactnativeble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanRecord
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Build
import android.os.ParcelUuid
import android.os.SystemClock
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap

/**
 * One advertisement, copied off the scan callback; `Int.MIN_VALUE` and null mean absent. The JNI side reads these
 * fields directly to build the JS `advertisement` event, with absent fields left out.
 */
internal class Advertisement(
  val deviceId: String,
  val name: String?,
  val rssi: Int,
  val manufacturerData: ByteArray?,
  /** Every manufacturer entry as company id (little-endian) + data, in the order Android parsed them. */
  val manufacturerEntries: Array<ByteArray>,
  val serviceDataUuids: Array<String>,
  val serviceDataValues: Array<ByteArray>,
  val serviceUuids: Array<String>,
  val txPowerLevel: Int,
  val connectable: Int,
  val scanRecord: ByteArray?,
  val isLegacy: Boolean,
  val primaryPhy: String,
  val secondaryPhy: String?,
  val advertisingSid: Int,
  val periodicAdvertisingInterval: Int,
  val timestampNanos: Long,
)

/** A hardware filter the scan hub asks for: exactly one kind of condition is set. */
internal data class HardwareFilter(
  val serviceUuid: String?,
  val name: String?,
  val companyId: Int?,
  val manufacturerData: List<Byte>,
  val manufacturerMask: List<Byte>,
  val serviceDataUuid: String?,
  val serviceData: List<Byte>,
  val serviceDataMask: List<Byte>,
)

/** The one native scan that covers every JS scan request; compared to skip needless restarts. */
internal data class ScanConfig(
  val services: List<String>?,
  val foregroundMode: String,
  val backgroundMode: String,
  val reportDelay: Long,
  val legacy: Boolean,
  val phy: String,
  val filters: List<HardwareFilter>?,
)

/**
 * Android's scan-start limit: 5 starts per 30 s for the whole app (SCAN_FAILED_SCANNING_TOO_FREQUENTLY), so the
 * history is process-wide, shared by the main scan and device lookups of every module instance (a reload makes a new
 * one while the old one's starts still count). Each start is stamped after `startScan` returns, so never before the
 * system's own stamp: once the oldest of the last 5 is 30 s old here, it is in the system's count too.
 */
internal object ScanStarts {
  private const val LIMIT = 5
  private const val WINDOW_MS = 30_000L

  private val starts = ArrayDeque<Long>()

  /** How long until Android allows another scan start. */
  @Synchronized
  fun delayMs(): Long {
    val now = SystemClock.elapsedRealtime()
    // Only the last 5 starts matter: the oldest of them sets the wait.
    while (starts.size > LIMIT) starts.removeFirst()
    while (starts.isNotEmpty() && now - starts.first() >= WINDOW_MS) starts.removeFirst()
    return if (starts.size >= LIMIT) starts.first() + WINDOW_MS - now else 0
  }

  @Synchronized
  fun recordStart() {
    starts.addLast(SystemClock.elapsedRealtime())
  }
}

/**
 * The single native scan behind every `startScan()`. Matching and duplicates happen in the C++ hub: this only
 * runs the scan the hub asked for and reports every advertisement.
 */
@SuppressLint("MissingPermission")
internal class BleScanner(private val central: BleCentral) {
  private var config: ScanConfig? = null
  // Read on the scan callback thread to drop a stale scan's results early; written only on the Bluetooth thread.
  @Volatile private var activeCallback: MainScanCallback? = null
  private var runningMode: String? = null
  private var foreground = true
  private val restart = whenAllowed(::scheduleRestart, ::restartNow)
  private val refresh = Runnable { if (config != null) scheduleRestart() }

  /**
   * Last advertised name per address, for device lists and advertisements that leave the name out; [NoName] when
   * the stack had none either, so a nameless device costs one `BluetoothDevice.getName` (a binder call) per cache
   * generation rather than one per advertisement.
   */
  private val names = AddressCache<Any>()

  /** Running or throttled device lookups by address; the main scan's sightings complete them too. */
  private val lookups = HashMap<String, Lookup>()
  /** Whether [lookups] has any, for the scan callback's thread: a lookup wants every sighting. */
  @Volatile private var hasLookups = false

  /**
   * Devices scanned since Bluetooth last turned on. Their `BluetoothDevice` carries the address type, and the
   * stack has a record of them: connecting by address alone to a random-address device the stack has no record of
   * (after Bluetooth restarts, or before any scan) uses the public type and never connects.
   */
  private val seen = AddressCache<BluetoothDevice>()

  fun nameOf(address: String): String? = names[address] as? String

  fun seenDevice(address: String): BluetoothDevice? = seen[address]

  fun setScan(next: ScanConfig?) {
    if (next == config && (next == null || activeCallback != null)) return
    config = next
    // Stopping does not count toward Android's scan-start limit, so it does not wait for it.
    if (next == null) {
      central.handler.removeCallbacks(restart)
      return stopNative()
    }
    scheduleRestart()
  }

  fun setForeground(value: Boolean) {
    foreground = value
    val config = config ?: return
    if (activeCallback != null && modeFor(config) != runningMode) scheduleRestart()
  }

  fun onBluetoothOff() {
    // The stack forgets every device it scanned.
    seen.clear()
    if (config == null) return
    stopNative()
    config = null
    central.handler.removeCallbacks(restart)
    emitError(BleException.bluetoothOff())
  }

  fun close() {
    central.handler.removeCallbacks(restart)
    config = null
    stopNative()
  }

  private fun modeFor(config: ScanConfig) = if (foreground) config.foregroundMode else config.backgroundMode

  /** Restarts the scan on the handler, at once unless Android's scan limit says to wait. */
  private fun scheduleRestart() {
    central.handler.removeCallbacks(restart)
    postWhenAllowed(restart, "Scan restart")
  }

  private fun restartNow() {
    stopNative()
    val config = config ?: return
    val error = central.unavailableError() ?: if (!central.hasScanPermission()) BleException.unauthorized() else null
    if (error != null) return failScan(error)
    val scanner = central.adapter?.bluetoothLeScanner ?: return failScan(BleException.bluetoothOff())

    val callback = MainScanCallback()
    val mode = modeFor(config)
    try {
      scanner.startScan(filtersOf(config), settingsOf(config, mode), callback)
    } catch (error: Exception) {
      return failScan(startError(error))
    }
    ScanStarts.recordStart()
    activeCallback = callback
    runningMode = mode
    central.handler.postDelayed(refresh, REFRESH_MS)
    central.delegate.log(LogLevel.DEBUG, "Scan started ($mode, services ${config.services ?: "all"})")
  }

  private fun stopNative() {
    central.handler.removeCallbacks(refresh)
    val callback = activeCallback ?: return
    activeCallback = null
    runningMode = null
    stopScan(callback)
  }

  private fun failScan(error: BleException) {
    stopNative()
    config = null
    emitError(error)
  }

  private fun emitError(error: BleException) {
    central.delegate.emit("scanError", payloadOf("error" to error.toPayload()))
  }

  private fun filtersOf(config: ScanConfig): List<ScanFilter> {
    config.services?.let { services ->
      return services.map { ScanFilter.Builder().setServiceUuid(ParcelUuid(Uuids.parse(it))).build() }
    }
    return config.filters.orEmpty().map { filter ->
      val builder = ScanFilter.Builder()
      filter.serviceUuid?.let { builder.setServiceUuid(ParcelUuid(Uuids.parse(it))) }
      filter.name?.let { builder.setDeviceName(it) }
      filter.companyId?.let { id ->
        val data = filter.manufacturerData.toByteArray()
        if (filter.manufacturerMask.isEmpty()) builder.setManufacturerData(id, data)
        else builder.setManufacturerData(id, data, maskOf(filter.manufacturerMask, data.size))
      }
      filter.serviceDataUuid?.let { uuid ->
        val data = filter.serviceData.toByteArray()
        if (filter.serviceDataMask.isEmpty()) builder.setServiceData(ParcelUuid(Uuids.parse(uuid)), data)
        else builder.setServiceData(ParcelUuid(Uuids.parse(uuid)), data, maskOf(filter.serviceDataMask, data.size))
      }
      builder.build()
    }
  }

  /**
   * Scans for one address until it advertises, then calls [onFound] once with the scanned device; for a connect to
   * a device the stack has no record of. Runs beside the scan JS asked for, whose sightings of the address also
   * complete it. [onFailed] is called once instead if the scan cannot run. [Lookup.cancel] stops it; the caller's
   * connect timeout bounds it.
   */
  fun lookup(
    address: String,
    lowPower: Boolean,
    onFound: (BluetoothDevice) -> Unit,
    onFailed: (BleException) -> Unit,
  ): Lookup =
    Lookup(address, lowPower, onFound, onFailed).also {
      lookups[address] = it
      hasLookups = true
      it.schedule()
    }

  inner class Lookup(
    private val address: String,
    private val lowPower: Boolean,
    private val onFound: (BluetoothDevice) -> Unit,
    private val onFailed: (BleException) -> Unit,
  ) {
    private var callback: ScanCallback? = null
    private var done = false
    private val start = whenAllowed(::schedule, ::startNow)
    // Restarted before Android demotes it to opportunistic after 30 minutes.
    private val refresh = Runnable {
      stop()
      schedule()
    }

    fun schedule() {
      postWhenAllowed(start, "Device lookup", address)
    }

    fun cancel() = finish()

    /** The device advertised, to this lookup's scan or the main one. */
    fun found(device: BluetoothDevice) {
      if (done) return
      finish()
      seen[address] = device
      onFound(device)
    }

    private fun fail(error: BleException) {
      if (done) return
      finish()
      onFailed(error)
    }

    private fun finish() {
      done = true
      lookups.remove(address, this)
      hasLookups = lookups.isNotEmpty()
      central.handler.removeCallbacks(start)
      central.handler.removeCallbacks(refresh)
      stop()
    }

    private fun startNow() {
      if (done) return
      if (!central.hasScanPermission()) return fail(BleException.unauthorized())
      val scanner = central.adapter?.bluetoothLeScanner ?: return fail(BleException.bluetoothOff())
      val callback =
        object : ScanCallback() {
          override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            central.post { if (callback === this) found(device) }
          }

          override fun onScanFailed(errorCode: Int) {
            central.post { if (callback === this) fail(scanFailure(errorCode)) }
          }
        }
      val filter = ScanFilter.Builder().setDeviceAddress(address).build()
      val settings =
        ScanSettings.Builder()
          .setScanMode(if (lowPower) ScanSettings.SCAN_MODE_LOW_POWER else ScanSettings.SCAN_MODE_LOW_LATENCY)
          .build()
      try {
        scanner.startScan(listOf(filter), settings, callback)
      } catch (error: Exception) {
        return fail(startError(error))
      }
      ScanStarts.recordStart()
      this.callback = callback
      central.handler.postDelayed(refresh, REFRESH_MS)
    }

    private fun stop() {
      central.handler.removeCallbacks(refresh)
      val callback = callback ?: return
      this.callback = null
      stopScan(callback)
    }
  }

  /**
   * A scan start that rechecks Android's scan-start limit when it runs, since another scan may have started after it
   * was posted: [start] if the limit allows, otherwise [retry].
   */
  private fun whenAllowed(retry: () -> Unit, start: () -> Unit): Runnable = Runnable { if (ScanStarts.delayMs() > 0) retry() else start() }

  /** Posts [start], at once unless Android's scan-start limit says to wait; [what] names the scan in the log. */
  private fun postWhenAllowed(start: Runnable, what: String, deviceId: String? = null) {
    val throttled = ScanStarts.delayMs()
    if (throttled > 0) central.delegate.log(LogLevel.INFO, "$what delayed ${throttled}ms by Android's scan limit", deviceId)
    central.handler.postDelayed(start, throttled)
  }

  private fun stopScan(callback: ScanCallback) {
    try {
      central.adapter?.bluetoothLeScanner?.stopScan(callback)
    } catch (_: Exception) {
      // Bluetooth already off, or permission revoked: the scan is gone either way.
    }
  }

  /** What a throwing `startScan` means, for the main scan and lookups alike. */
  private fun startError(error: Exception): BleException =
    when (error) {
      is SecurityException -> BleException.unauthorized()
      is IllegalStateException -> BleException.bluetoothOff()
      is IllegalArgumentException -> BleException("scan-failed", "Invalid scan settings: ${error.message}")
      else -> BleException("scan-failed", "The scan could not start: $error")
    }

  /** An `onScanFailed` code, for the main scan and lookups alike. */
  private fun scanFailure(errorCode: Int): BleException =
    when (errorCode) {
      ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY ->
        BleException("scan-throttled", "Android refused the scan: started too often", errorCode, BleException.SCAN_DOMAIN)
      ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED ->
        BleException("unsupported", "This phone does not support these scan settings", errorCode, BleException.SCAN_DOMAIN)
      else -> BleException("scan-failed", "The scan failed with code $errorCode", errorCode, BleException.SCAN_DOMAIN)
    }

  /** Android wants the mask as long as the data; missing mask bytes compare fully (0xff). */
  private fun maskOf(mask: List<Byte>, length: Int) = ByteArray(length) { mask.getOrElse(it) { 0xff.toByte() } }

  private fun settingsOf(config: ScanConfig, mode: String): ScanSettings {
    val builder =
      ScanSettings.Builder()
        .setScanMode(
          when (mode) {
            "opportunistic" -> ScanSettings.SCAN_MODE_OPPORTUNISTIC
            "low-power" -> ScanSettings.SCAN_MODE_LOW_POWER
            "balanced" -> ScanSettings.SCAN_MODE_BALANCED
            else -> ScanSettings.SCAN_MODE_LOW_LATENCY
          }
        )
        .setReportDelay(config.reportDelay)
    if (Build.VERSION.SDK_INT >= 26) {
      builder.setLegacy(config.legacy)
      builder.setPhy(
        when (config.phy) {
          "coded" -> BluetoothDevice.PHY_LE_CODED
          "all" -> ScanSettings.PHY_LE_ALL_SUPPORTED
          else -> BluetoothDevice.PHY_LE_1M
        }
      )
    }
    return builder.build()
  }

  private inner class MainScanCallback : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      report(result)
    }

    override fun onBatchScanResults(results: MutableList<ScanResult>) {
      for (result in results) report(result)
    }

    override fun onScanFailed(errorCode: Int) {
      val error = scanFailure(errorCode)
      central.post { if (activeCallback === this) failScan(error) }
    }

    private fun report(result: ScanResult) {
      // A stopped scan's late results are dropped before any work; the post checks again on the handler thread.
      if (activeCallback !== this) return
      val device = result.device
      val address = device.address
      seen[address] = device
      // Most of what a scan hears repeats a device every scan reported already: only its name is kept.
      if (!hasLookups && central.delegate.isDuplicateAdvertisement(address)) {
        result.scanRecord?.deviceName?.let { if (it != names[address]) names[address] = it }
        return
      }
      val advertisement = advertisementOf(result)
      central.post {
        if (activeCallback !== this) return@post
        lookups[device.address]?.found(device)
        central.delegate.emitAdvertisement(advertisement)
      }
    }
  }

  /** Copies everything the advertisement event needs from `result`, on the callback thread. */
  private fun advertisementOf(result: ScanResult): Advertisement {
    val record = result.scanRecord
    val address = result.device.address
    val cached = names[address]
    val name = record?.deviceName ?: cached as? String ?: if (cached == null) central.nameOrNull(result.device) else null
    if (name != null) {
      if (name != cached) names[address] = name
    } else if (cached == null) {
      names[address] = NoName
    }

    // The arrays below belong to this ScanResult, which only this callback sees and nothing writes to: no copies.
    val manufacturerEntries = record?.manufacturerEntries() ?: NO_ENTRIES
    val serviceData = record?.serviceData
    val serviceDataUuids: Array<String>
    val serviceDataValues: Array<ByteArray>
    if (serviceData.isNullOrEmpty()) {
      serviceDataUuids = NO_STRINGS
      serviceDataValues = NO_ENTRIES
    } else {
      val values = arrayOfNulls<ByteArray>(serviceData.size)
      val entries = serviceData.entries.iterator()
      serviceDataUuids =
        Array(serviceData.size) { index ->
          val (uuid, data) = entries.next()
          values[index] = data
          Uuids.format(uuid.uuid)
        }
      // Every slot is filled above.
      @Suppress("UNCHECKED_CAST")
      serviceDataValues = values as Array<ByteArray>
    }
    val uuids = record?.serviceUuids
    val serviceUuids = if (uuids.isNullOrEmpty()) NO_STRINGS else Array(uuids.size) { Uuids.format(uuids[it].uuid) }
    val modern = Build.VERSION.SDK_INT >= 26
    val txPower =
      when {
        record != null && record.txPowerLevel != Int.MIN_VALUE -> record.txPowerLevel
        modern && result.txPower != ScanResult.TX_POWER_NOT_PRESENT -> result.txPower
        else -> Int.MIN_VALUE
      }

    return Advertisement(
      deviceId = address,
      name = name,
      rssi = result.rssi,
      manufacturerData = manufacturerEntries.firstOrNull(),
      manufacturerEntries = manufacturerEntries,
      serviceDataUuids = serviceDataUuids,
      serviceDataValues = serviceDataValues,
      serviceUuids = serviceUuids,
      txPowerLevel = txPower,
      connectable = if (!modern) Int.MIN_VALUE else if (result.isConnectable) 1 else 0,
      scanRecord = record?.bytes,
      isLegacy = !modern || result.isLegacy,
      primaryPhy = if (modern && result.primaryPhy == BluetoothDevice.PHY_LE_CODED) "coded" else "le1m",
      secondaryPhy = if (modern) phyNameOf(result.secondaryPhy) else null,
      advertisingSid =
        if (modern && result.advertisingSid != ScanResult.SID_NOT_PRESENT) result.advertisingSid else Int.MIN_VALUE,
      periodicAdvertisingInterval =
        if (modern && result.periodicAdvertisingInterval != ScanResult.PERIODIC_INTERVAL_NOT_PRESENT) {
          result.periodicAdvertisingInterval
        } else {
          Int.MIN_VALUE
        },
      timestampNanos = result.timestampNanos,
    )
  }

  /**
   * Every manufacturer entry as company id (little-endian) followed by its bytes, in SparseArray order. The first
   * is the top-level `manufacturerData`, the way iOS reports it.
   */
  private fun ScanRecord.manufacturerEntries(): Array<ByteArray> {
    val entries = manufacturerSpecificData ?: return NO_ENTRIES
    return Array(entries.size()) { index ->
      val id = entries.keyAt(index)
      val bytes = entries.valueAt(index) ?: ByteArray(0)
      ByteArray(bytes.size + 2).also { entry ->
        entry[0] = (id and 0xff).toByte()
        entry[1] = ((id shr 8) and 0xff).toByte()
        bytes.copyInto(entry, 2)
      }
    }
  }

  /**
   * Values by address, bounded: written on the scan callback thread, read from any thread. Two generations instead
   * of an LRU: a lookup checks both, and once [current] holds [LIMIT] entries it becomes [previous], dropping the
   * older generation, so a busy place cannot grow it without bound and recent entries survive a turnover.
   */
  /** In [names]: the stack has no name for the address either. */
  private object NoName

  private class AddressCache<V : Any> {
    @Volatile private var current = ConcurrentHashMap<String, V>()
    @Volatile private var previous = ConcurrentHashMap<String, V>()

    operator fun get(address: String): V? = current[address] ?: previous[address]

    operator fun set(address: String, value: V) {
      val map = current
      if (map.put(address, value) == null && map.size > LIMIT) {
        synchronized(this) {
          if (current === map) {
            previous = map
            current = ConcurrentHashMap()
          }
        }
      }
    }

    @Synchronized
    fun clear() {
      current = ConcurrentHashMap()
      previous = ConcurrentHashMap()
    }

    private companion object {
      const val LIMIT = 512
    }
  }

  private companion object {
    val NO_ENTRIES = emptyArray<ByteArray>()
    val NO_STRINGS = emptyArray<String>()

    /**
     * Android demotes a scan running past 30 minutes to opportunistic, which hears almost nothing. Restarting at 25
     * leaves a margin well beyond the up to 30 s a restart may wait out the scan-start limit, for one start in 25
     * minutes.
     */
    const val REFRESH_MS = 25 * 60_000L
  }
}
