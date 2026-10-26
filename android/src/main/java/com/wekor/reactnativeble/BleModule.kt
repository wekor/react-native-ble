package com.wekor.reactnativeble

import android.bluetooth.BluetoothDevice
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.BindingsInstallerHolder
import com.facebook.react.turbomodule.core.interfaces.TurboModuleWithJSIBindings
import com.facebook.soloader.SoLoader
import java.util.concurrent.locks.StampedLock

/**
 * The spec's surface. Every method returns at once: it reads its arguments here, on the JS thread, and hands
 * the work to [BleCentral]'s thread, which answers with events through the C++ bridge.
 */
@ReactModule(name = BleModule.NAME)
class BleModule(reactContext: ReactApplicationContext) :
  NativeReactNativeBleSpec(reactContext), TurboModuleWithJSIBindings, LifecycleEventListener {

  /**
   * Guards only the lifetime of the `std::shared_ptr<BleBridge>` holder [bridgePointer] points at: `nativeDestroy`
   * deletes it, so no call may be dereferencing it then. The BleBridge itself is thread-safe (its event queue, byte
   * store and scan hub each have their own mutex, and each thread's events keep their order), so emits from the
   * Bluetooth thread, the L2CAP readers and `takeBytes` on the JS thread share the read side and never wait on each
   * other.
   */
  private val bridgeLock = StampedLock()
  private var bridgePointer: Long = nativeCreate()

  @Volatile private var logLevel = LogLevel.WARN

  private val delegate =
    object : BleCentralDelegate {
      override fun emit(type: String, payload: Map<String, Any?>) = this@BleModule.emit(type, payload)

      override fun emitResult(opId: Double, value: Any?, error: Map<String, Any?>?) =
        this@BleModule.emitResult(opId, value, error)

      override fun emitAdvertisement(advertisement: Advertisement) = this@BleModule.emitAdvertisement(advertisement)

      override fun isDuplicateAdvertisement(deviceId: String) = this@BleModule.isDuplicateAdvertisement(deviceId)

      override fun emitNotification(deviceId: String, service: String, characteristic: String, value: ByteArray) =
        this@BleModule.emitNotification(deviceId, service, characteristic, value)

      override fun emitL2capData(channelId: Int, buffer: ByteArray, count: Int) =
        this@BleModule.emitL2capData(channelId, buffer, count)

      override fun log(level: LogLevel, message: String, deviceId: String?) = this@BleModule.log(level, message, deviceId)
    }

  private val central = BleCentral(reactContext, delegate)

  init {
    reactContext.addLifecycleEventListener(this)
  }

  override fun getBindingsInstaller(): BindingsInstallerHolder = withBridge { nativeBindingsInstaller(it) }

  private external fun nativeBindingsInstaller(pointer: Long): BindingsInstallerHolder

  private external fun nativeCreate(): Long

  private external fun nativeDestroy(pointer: Long)

  private external fun nativeEmit(pointer: Long, type: String, payload: Any?)

  private external fun nativeEmitResult(pointer: Long, opId: Double, value: Any?, error: Any?)

  private external fun nativeEmitAdvertisement(pointer: Long, advertisement: Advertisement)

  private external fun nativeIsDuplicateAdvertisement(pointer: Long, deviceId: String): Boolean

  private external fun nativeEmitNotification(
    pointer: Long,
    deviceId: String,
    service: String,
    characteristic: String,
    value: ByteArray,
  )

  private external fun nativeEmitL2capData(pointer: Long, channelId: Int, buffer: ByteArray, count: Int)

  private external fun nativeTakeBytes(pointer: Long, handle: Long): ByteArray?

  // Bridge

  /** Runs `use` with the live bridge pointer (0 once invalidated) while `nativeDestroy` cannot free it. */
  private inline fun <T> withBridge(use: (Long) -> T): T {
    val stamp = bridgeLock.readLock()
    try {
      return use(bridgePointer)
    } finally {
      bridgeLock.unlockRead(stamp)
    }
  }

  private fun emit(type: String, payload: Map<String, Any?>) {
    withBridge { if (it != 0L) nativeEmit(it, type, payload) }
  }

  private fun emitResult(opId: Double, value: Any?, error: Map<String, Any?>?) {
    withBridge { if (it != 0L) nativeEmitResult(it, opId, value, error) }
  }

  private fun emitAdvertisement(advertisement: Advertisement) {
    withBridge { if (it != 0L) nativeEmitAdvertisement(it, advertisement) }
  }

  private fun emitNotification(deviceId: String, service: String, characteristic: String, value: ByteArray) {
    withBridge { if (it != 0L) nativeEmitNotification(it, deviceId, service, characteristic, value) }
  }

  private fun emitL2capData(channelId: Int, buffer: ByteArray, count: Int) {
    withBridge { if (it != 0L) nativeEmitL2capData(it, channelId, buffer, count) }
  }

  private fun isDuplicateAdvertisement(deviceId: String): Boolean =
    withBridge { it != 0L && nativeIsDuplicateAdvertisement(it, deviceId) }

  private fun takeBytes(handle: Long): ByteArray? = withBridge { if (it != 0L) nativeTakeBytes(it, handle) else null }

  private fun log(level: LogLevel, message: String, deviceId: String?) {
    if (level.ordinal < logLevel.ordinal) return
    emit("log", payloadOf("level" to level.label, "message" to message, "deviceId" to deviceId))
  }

  // Lifecycle

  override fun onHostResume() = central.onHostResume()

  override fun onHostPause() = central.setForeground(false)

  override fun onHostDestroy() = central.onActivityDestroyed()

  override fun invalidate() {
    reactApplicationContext.removeLifecycleEventListener(this)
    central.close()
    val stamp = bridgeLock.writeLock()
    try {
      nativeDestroy(bridgePointer)
      bridgePointer = 0L
    } finally {
      bridgeLock.unlockWrite(stamp)
    }
    super.invalidate()
  }

  // Spec

  override fun configure(options: ReadableMap): Boolean {
    options.stringOrNull("logLevel")?.let { logLevel = LogLevel.of(it) }
    return true
  }

  override fun getState(): String = central.state

  override fun getPermission(opId: Double) = central.postOp(opId) { central.result(opId, central.permissionResponse()) }

  override fun requestPermission(opId: Double) = central.postOp(opId) { central.requestPermission(opId) }

  override fun setScan(config: ReadableMap?): Boolean {
    val scan = config?.let(::scanConfigOf)
    return central.post { central.scanner.setScan(scan) }
  }

  override fun connect(opId: Double, deviceId: String, options: ReadableMap): Boolean {
    // Parsed in the op, so a bad option fails it like any other error.
    return central.postOp(opId) { central.connect(opId, deviceId, connectOptionsOf(options)) }
  }

  override fun disconnect(opId: Double, deviceId: String) = central.postOp(opId) { central.disconnect(opId, deviceId) }

  override fun read(opId: Double, deviceId: String, service: String, characteristic: String, timeout: Double) =
    central.postOp(opId) { central.enqueue(deviceId, GattOp.Read(opId, timeout.toLong(), service, characteristic)) }

  override fun write(
    opId: Double,
    deviceId: String,
    service: String,
    characteristic: String,
    valueHandle: Double,
    withoutResponse: Boolean,
    timeout: Double,
  ): Boolean {
    val bytes = takeBytes(valueHandle.toLong()) ?: return central.postFail(opId, BleException.valueNotFound())
    return central.postOp(opId) {
      central.enqueue(deviceId, GattOp.Write(opId, timeout.toLong(), service, characteristic, bytes, withoutResponse))
    }
  }

  override fun setNotify(
    opId: Double,
    deviceId: String,
    service: String,
    characteristic: String,
    enable: Boolean,
    indicate: Boolean,
    timeout: Double,
  ) =
    central.postOp(opId) {
      central.enqueue(deviceId, GattOp.SetNotify(opId, timeout.toLong(), service, characteristic, enable, indicate))
    }

  override fun readDescriptor(
    opId: Double,
    deviceId: String,
    service: String,
    characteristic: String,
    descriptor: String,
    timeout: Double,
  ) =
    central.postOp(opId) {
      central.enqueue(deviceId, GattOp.ReadDescriptor(opId, timeout.toLong(), service, characteristic, descriptor))
    }

  override fun writeDescriptor(
    opId: Double,
    deviceId: String,
    service: String,
    characteristic: String,
    descriptor: String,
    valueHandle: Double,
    timeout: Double,
  ): Boolean {
    val bytes = takeBytes(valueHandle.toLong()) ?: return central.postFail(opId, BleException.valueNotFound())
    return central.postOp(opId) {
      central.enqueue(deviceId, GattOp.WriteDescriptor(opId, timeout.toLong(), service, characteristic, descriptor, bytes))
    }
  }

  override fun readRssi(opId: Double, deviceId: String, timeout: Double) =
    central.postOp(opId) { central.enqueue(deviceId, GattOp.ReadRssi(opId, timeout.toLong())) }

  override fun maxWriteLength(deviceId: String, withoutResponse: Boolean): Double =
    central.maxWriteLength(deviceId, withoutResponse).toDouble()

  // Android lists connected devices without their services, so JS passes none: the spec's `services` is iOS's.
  override fun getConnectedDevices(opId: Double, services: ReadableArray) = central.postOp(opId) { central.getConnectedDevices(opId) }

  override fun openL2capChannel(opId: Double, deviceId: String, psm: Double, secure: Boolean, timeout: Double) =
    central.postOp(opId) { central.l2cap.open(opId, deviceId, psm.toInt(), secure, timeout.toLong()) }

  override fun writeL2capChannel(opId: Double, channelId: Double, valueHandle: Double): Boolean {
    val bytes = takeBytes(valueHandle.toLong()) ?: return central.postFail(opId, BleException.valueNotFound())
    return central.postOp(opId) { central.l2cap.write(opId, channelId.toInt(), bytes) }
  }

  override fun closeL2capChannel(opId: Double, channelId: Double) = central.postOp(opId) { central.l2cap.close(opId, channelId.toInt()) }

  override fun requestEnable(opId: Double) = central.postOp(opId) { central.requestEnable(opId) }

  override fun getBondedDevices(opId: Double) = central.postOp(opId) { central.getBondedDevices(opId) }

  override fun requestMtu(opId: Double, deviceId: String, mtu: Double, timeout: Double) =
    central.postOp(opId) { central.enqueue(deviceId, GattOp.RequestMtu(opId, timeout.toLong(), mtu.toInt())) }

  override fun requestPriority(opId: Double, deviceId: String, priority: String) =
    central.postOp(opId) { central.enqueue(deviceId, GattOp.RequestPriority(opId, priority)) }

  override fun setPhy(opId: Double, deviceId: String, options: ReadableMap, timeout: Double): Boolean {
    val tx = options.arrayOrNull("tx")?.strings()
    val rx = options.arrayOrNull("rx")?.strings()
    val coded = options.stringOrNull("codedOption")
    return central.postOp(opId) { central.enqueue(deviceId, GattOp.SetPhy(opId, timeout.toLong(), tx, rx, coded)) }
  }

  override fun readPhy(opId: Double, deviceId: String, timeout: Double) =
    central.postOp(opId) { central.enqueue(deviceId, GattOp.ReadPhy(opId, timeout.toLong())) }

  override fun bond(opId: Double, deviceId: String) = central.postOp(opId) { central.bonds.bond(opId, deviceId) }

  override fun unbond(opId: Double, deviceId: String) = central.postOp(opId) { central.bonds.unbond(opId, deviceId) }

  override fun getBondState(deviceId: String): String = central.bonds.stateOf(deviceId)

  override fun refreshCache(opId: Double, deviceId: String, timeout: Double) =
    central.postOp(opId) { central.enqueue(deviceId, GattOp.RefreshCache(opId, timeout.toLong())) }

  override fun rediscoverServices(opId: Double, deviceId: String, timeout: Double) =
    central.postOp(opId) { central.enqueue(deviceId, GattOp.Rediscover(opId, timeout.toLong())) }

  override fun getAncsAuthorized(deviceId: String) = false

  companion object {
    const val NAME = NativeReactNativeBleSpec.NAME

    init {
      SoLoader.loadLibrary("reactnativeble")
    }
  }
}

// Arguments from JS, read into the types the Bluetooth code takes

/** `connect()`'s options. */
private fun connectOptionsOf(options: ReadableMap): ConnectOptions {
  val android = options.mapOrNull("android")
  return ConnectOptions(
    // JS always sends one, its configured default when the caller gave none.
    timeout = options.doubleOrNull("timeout")?.toLong() ?: throw BleException("invalid-argument", "connect() needs a timeout"),
    services = options.arrayOrNull("services")?.strings()?.map(Uuids::parse)?.toSet(),
    autoConnect = android?.boolOrNull("autoConnect") ?: false,
    transport =
      when (android?.stringOrNull("transport")) {
        "auto" -> BluetoothDevice.TRANSPORT_AUTO
        "bredr" -> BluetoothDevice.TRANSPORT_BREDR
        else -> BluetoothDevice.TRANSPORT_LE
      },
    phyMask = phyMaskOf(android?.arrayOrNull("phy")?.strings()),
    mtu = android?.doubleOrNull("mtu")?.toInt() ?: BleConnection.MAX_MTU,
    priority = android?.stringOrNull("priority") ?: "balanced",
  )
}

/** The native scan the C++ hub merged from every JS scan. */
private fun scanConfigOf(config: ReadableMap): ScanConfig {
  val android = config.mapOrNull("android")
  val modes = android?.mapOrNull("scanMode")
  return ScanConfig(
    services = config.arrayOrNull("services")?.strings(),
    foregroundMode = modes?.stringOrNull("foreground") ?: "low-latency",
    backgroundMode = modes?.stringOrNull("background") ?: "low-power",
    reportDelay = android?.doubleOrNull("reportDelay")?.toLong() ?: 0,
    legacy = android?.boolOrNull("legacy") ?: true,
    phy = android?.stringOrNull("phy") ?: "le1m",
    filters =
      android?.arrayOrNull("filters")?.let { array ->
        (0..<array.size()).mapNotNull { index -> array.getMap(index)?.let(::hardwareFilterOf) }
      },
  )
}

private fun hardwareFilterOf(filter: ReadableMap) =
  HardwareFilter(
    serviceUuid = filter.stringOrNull("serviceUuid"),
    name = filter.stringOrNull("name"),
    companyId = filter.doubleOrNull("companyId")?.toInt(),
    manufacturerData = filter.arrayOrNull("manufacturerData")?.bytes()?.toList().orEmpty(),
    manufacturerMask = filter.arrayOrNull("manufacturerMask")?.bytes()?.toList().orEmpty(),
    serviceDataUuid = filter.stringOrNull("serviceDataUuid"),
    serviceData = filter.arrayOrNull("serviceData")?.bytes()?.toList().orEmpty(),
    serviceDataMask = filter.arrayOrNull("serviceDataMask")?.bytes()?.toList().orEmpty(),
  )

private fun ReadableMap.stringOrNull(key: String): String? =
  if (hasKey(key) && getType(key) == ReadableType.String) getString(key) else null

private fun ReadableMap.doubleOrNull(key: String): Double? =
  if (hasKey(key) && getType(key) == ReadableType.Number) getDouble(key) else null

private fun ReadableMap.boolOrNull(key: String): Boolean? =
  if (hasKey(key) && getType(key) == ReadableType.Boolean) getBoolean(key) else null

private fun ReadableMap.mapOrNull(key: String): ReadableMap? =
  if (hasKey(key) && getType(key) == ReadableType.Map) getMap(key) else null

private fun ReadableMap.arrayOrNull(key: String): ReadableArray? =
  if (hasKey(key) && getType(key) == ReadableType.Array) getArray(key) else null

private fun ReadableArray.strings(): List<String> =
  (0..<size()).mapNotNull { if (getType(it) == ReadableType.String) getString(it) else null }

private fun ReadableArray.bytes(): ByteArray = ByteArray(size()) { getDouble(it).toInt().toByte() }
