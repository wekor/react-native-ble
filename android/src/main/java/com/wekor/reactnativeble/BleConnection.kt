package com.wekor.reactnativeble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.os.Build
import java.util.ArrayDeque
import java.util.UUID

/** How to connect, from `connect()`'s options; the module parses them from JS. */
internal data class ConnectOptions(
  val timeout: Long,
  val services: Set<UUID>?,
  val autoConnect: Boolean,
  val transport: Int,
  val phyMask: Int,
  val mtu: Int,
  val priority: String,
)

/** One GATT operation in a connection's queue. `timeout` is in ms; 0 waits forever. */
internal sealed class GattOp(val opId: Double, val timeout: Long) {
  /** JS has its answer already: the op timed out and now only waits for its late callback. */
  var hasTimedOut = false

  /** Queued by the connection itself, not by JS: nothing is answered for it. */
  var isInternal = false

  class Read(opId: Double, timeout: Long, val service: String, val characteristic: String) : GattOp(opId, timeout)

  class Write(
    opId: Double,
    timeout: Long,
    val service: String,
    val characteristic: String,
    val value: ByteArray,
    val withoutResponse: Boolean,
  ) : GattOp(opId, timeout)

  class SetNotify(
    opId: Double,
    timeout: Long,
    val service: String,
    val characteristic: String,
    val enable: Boolean,
    val indicate: Boolean,
  ) : GattOp(opId, timeout)

  class ReadDescriptor(opId: Double, timeout: Long, val service: String, val characteristic: String, val descriptor: String) :
    GattOp(opId, timeout)

  class WriteDescriptor(
    opId: Double,
    timeout: Long,
    val service: String,
    val characteristic: String,
    val descriptor: String,
    val value: ByteArray,
  ) : GattOp(opId, timeout)

  class ReadRssi(opId: Double, timeout: Long) : GattOp(opId, timeout)

  class RequestMtu(opId: Double, timeout: Long, val mtu: Int) : GattOp(opId, timeout)

  class RequestPriority(opId: Double, val priority: String) : GattOp(opId, 0)

  class SetPhy(opId: Double, timeout: Long, val tx: List<String>?, val rx: List<String>?, val codedOption: String?) :
    GattOp(opId, timeout) {
    /** A coding (S2/S8) asked for on a coded PHY: something to request even when the PHYs already match. */
    val wantsCodedOption =
      (codedOption == "s2" || codedOption == "s8") && ("coded" in tx.orEmpty() || "coded" in rx.orEmpty())
  }

  class ReadPhy(opId: Double, timeout: Long) : GattOp(opId, timeout)

  class RefreshCache(opId: Double, timeout: Long) : GattOp(opId, timeout)

  /** Service discovery after a `servicesChanged` event; answers with the services. */
  class Rediscover(opId: Double, timeout: Long) : GattOp(opId, timeout)

  /** Which characteristic or descriptor a callback must name to complete this op, or a [SetPhy] step. */
  var awaiting: Any? = null
}

/**
 * One device's link and its GATT queue: exactly one operation in flight, FIFO, each with its own timeout.
 * Everything runs on [BleCentral.handler]; GATT callbacks copy their values on the binder thread and post here.
 */
@SuppressLint("MissingPermission")
internal class BleConnection(private val central: BleCentral, private val device: BluetoothDevice) {
  private enum class State(val label: String) {
    DISCONNECTED("disconnected"),
    CONNECTING("connecting"),
    CONNECTED("connected"),
    DISCONNECTING("disconnecting"),
  }

  val id: String = device.address
  private val delegate = central.delegate
  private val handler = central.handler

  private var state = State.DISCONNECTED
  private var gatt: BluetoothGatt? = null
  private var callback: GattCallback? = null
  /** The scan that finds the device first when the stack has no record of it. */
  private var lookup: BleScanner.Lookup? = null
  private var options: ConnectOptions? = null
  private var discovering = false
  /** Set while the link is being dropped: the queue starts nothing more on it. */
  private var halted = false

  /** A pending `connect()`, with its caller's timeout running from the call, wherever the connection stands. */
  private inner class ConnectWaiter(val opId: Double, timeout: Long) {
    val timer = Runnable { onConnectTimeout(this) }

    init {
      if (timeout > 0) handler.postDelayed(timer, timeout)
    }
  }

  private val connectWaiters = ArrayList<ConnectWaiter>()
  private val disconnectWaiters = ArrayList<Double>()
  /** The options of the connect queued behind a disconnect; they become [options] when it starts. */
  private var queuedOptions: ConnectOptions? = null

  private val queue = ArrayDeque<GattOp>()
  private var current: GattOp? = null

  @Volatile var mtu = DEFAULT_MTU
    private set

  @Volatile var isConnected = false
    private set

  private val opTimeout = Runnable { onOpTimeout() }

  /** UUIDs by the strings ops name them with, parsed once; emptied whenever the services may change. */
  private val uuids = HashMap<String, UUID>()

  // Connect

  /**
   * A connect joining one already under way, or queued behind a disconnect, shares that attempt: the first
   * connect's options win (services, MTU, autoConnect...), while each caller's own timeout bounds its wait.
   */
  fun connect(opId: Double, options: ConnectOptions) {
    when (state) {
      // Never mid-drop: `dropLink` runs to DISCONNECTED in one go on this thread, so a connect after it starts anew.
      State.CONNECTED -> central.result(opId, connectedValue())
      State.CONNECTING -> connectWaiters.add(ConnectWaiter(opId, options.timeout))
      // Queued: the connect starts once the device confirms the disconnect.
      State.DISCONNECTING -> {
        if (connectWaiters.isEmpty()) queuedOptions = options
        connectWaiters.add(ConnectWaiter(opId, options.timeout))
      }
      State.DISCONNECTED -> {
        this.options = options
        connectWaiters.add(ConnectWaiter(opId, options.timeout))
        startConnect()
      }
    }
  }

  /** One caller's timeout: it fails alone, and the attempt ends once no one waits for it. */
  private fun onConnectTimeout(waiter: ConnectWaiter) {
    if (!connectWaiters.remove(waiter)) return
    val error = BleException("timeout", "No connection within the timeout")
    central.fail(waiter.opId, error)
    if (connectWaiters.isNotEmpty()) return
    queuedOptions = null
    failConnect(error)
  }

  private fun settleConnectWaiters(answer: (Double) -> Unit) {
    val waiters = connectWaiters.toList()
    connectWaiters.clear()
    for (waiter in waiters) {
      handler.removeCallbacks(waiter.timer)
      answer(waiter.opId)
    }
  }

  /**
   * Connects to the scanned `BluetoothDevice` when there is one. A device the stack has no record of, such as a saved
   * address after Bluetooth restarted, is scanned for first: connecting to it by address alone would use the public
   * address type, and a random-address device would never connect. The callers' connect timeouts cover every step
   * up to discovered services: lookup, link, MTU exchange and discovery each wait only for the callback that ends them.
   */
  private fun startConnect() {
    val options = options ?: return
    setState(State.CONNECTING)
    central.deviceForDirectConnect(device)?.let { return openGatt(it) }
    if (!central.hasScanPermission()) return failConnect(BleException.unauthorized())
    delegate.log(LogLevel.DEBUG, "The stack has no record of the device; scanning for it first", id)
    lookup =
      central.scanner.lookup(
        id,
        lowPower = options.autoConnect,
        onFound = { found ->
          lookup = null
          if (state == State.CONNECTING && gatt == null) openGatt(found)
        },
        onFailed = { error ->
          lookup = null
          failConnect(error)
        },
      )
  }

  @Suppress("DEPRECATION")
  private fun openGatt(device: BluetoothDevice) {
    val options = options ?: return
    val callback = GattCallback()
    this.callback = callback
    delegate.log(LogLevel.DEBUG, "connectGatt(autoConnect=${options.autoConnect})", id)
    val gatt =
      try {
        // The callback exists before connectGatt: its first event can arrive before the call returns.
        if (Build.VERSION.SDK_INT >= 26) {
          device.connectGatt(central.appContext, options.autoConnect, callback, options.transport, options.phyMask)
        } else {
          device.connectGatt(central.appContext, options.autoConnect, callback, options.transport)
        }
      } catch (_: SecurityException) {
        return failConnect(BleException.unauthorized())
      }
    if (gatt == null) return failConnect(BleException("connection-failed", "connectGatt returned null"))
    this.gatt = gatt
  }

  private fun onLinkUp() {
    val gatt = gatt ?: return
    val options = options ?: return
    if (options.priority != "balanced") {
      // No callback reports the result, so fire and forget; sent first so the MTU exchange and discovery use it.
      gatt.requestConnectionPriority(priorityOf(options.priority))
    }
    // Once requestMtu returns true, onMtuChanged follows and starts discovery.
    if (options.mtu <= 0 || !gatt.requestMtu(options.mtu)) discover()
  }

  private fun discover() {
    if (state != State.CONNECTING || discovering) return
    val gatt = gatt ?: return
    discovering = true
    if (!gatt.discoverServices()) failConnect(BleException("connection-failed", "Service discovery could not start"))
  }

  private fun onConnectDiscoveryFinished(status: Int) {
    if (state != State.CONNECTING) return
    if (status != BluetoothGatt.GATT_SUCCESS) {
      return failConnect(BleException("connection-failed", "Service discovery failed", status, BleException.GATT_DOMAIN))
    }
    isConnected = true
    setState(State.CONNECTED)
    val value = connectedValue()
    settleConnectWaiters { central.result(it, value) }
    startNextOp()
  }

  private fun failConnect(error: BleException) {
    if (state != State.CONNECTING) return
    cancelLookup()
    closeGatt()
    resetLink()
    // No op is queued: ops are only accepted while connected, and every way out of CONNECTED fails them.
    settleConnectWaiters { central.fail(it, error) }
    setState(State.DISCONNECTED)
    answerDisconnectWaiters()
    central.onConnectionIdle(this)
  }

  private fun connectedValue(): Map<String, Any?> = payloadOf("mtu" to mtu, "services" to servicesValue())

  private fun servicesValue(): List<Any?> {
    val gatt = gatt ?: return emptyList()
    return servicesPayload(gatt, options?.services)
  }

  // Disconnect

  fun disconnect(opId: Double) {
    when (state) {
      State.DISCONNECTED -> central.result(opId)
      State.CONNECTING -> {
        disconnectWaiters.add(opId)
        failConnect(BleException.cancelledByDisconnect())
      }
      State.CONNECTED -> {
        disconnectWaiters.add(opId)
        setState(State.DISCONNECTING)
        // Settles on onConnectionStateChange(DISCONNECTED); Bluetooth off and module teardown also end it. If the
        // request cannot even be made, no callback will come: end the link here.
        val gatt = gatt
        val requested =
          gatt != null &&
            try {
              gatt.disconnect()
              true
            } catch (error: Exception) {
              delegate.log(LogLevel.WARN, "disconnect() threw: $error", id)
              false
            }
        if (!requested) finishDisconnect(null)
      }
      State.DISCONNECTING -> {
        disconnectWaiters.add(opId)
        // A connect queued behind this disconnect was asked for before this call: it no longer happens.
        queuedOptions = null
        settleConnectWaiters { central.fail(it, BleException.cancelledByDisconnect()) }
      }
    }
  }

  /** The end of an established connection, asked for (`error` null) or not. */
  private fun finishDisconnect(error: BleException?) {
    if (state != State.CONNECTED && state != State.DISCONNECTING) return
    // A user's disconnect that was overtaken by a failure still reads as asked for.
    val reason = if (state == State.DISCONNECTING) null else error
    closeGatt()
    resetLink()
    // Operations cut off by Bluetooth turning off say so; to them any other end is a disconnect.
    failOps(if (error?.code == "bluetooth-off") error else BleException.disconnected())
    central.l2cap.closeFor(id)
    delegate.emit("disconnected", payloadOf("deviceId" to id, "error" to reason?.toPayload()))
    setState(State.DISCONNECTED)
    answerDisconnectWaiters()
    // A connect asked for while disconnecting starts now, unless Bluetooth turning off ended the link.
    val queued = queuedOptions
    queuedOptions = null
    if (connectWaiters.isNotEmpty() && error?.code == "bluetooth-off") settleConnectWaiters { central.fail(it, error) }
    if (connectWaiters.isEmpty()) return central.onConnectionIdle(this)
    options = queued ?: options
    startConnect()
  }

  private fun answerDisconnectWaiters() {
    for (opId in disconnectWaiters) central.result(opId)
    disconnectWaiters.clear()
  }

  fun onBluetoothOff() {
    when (state) {
      State.CONNECTING -> failConnect(BleException.bluetoothOff())
      State.CONNECTED,
      State.DISCONNECTING -> finishDisconnect(BleException.bluetoothOff())
      State.DISCONNECTED -> Unit
    }
  }

  /** Module teardown: release the link without reporting. */
  fun close() {
    cancelLookup()
    closeGatt()
    resetLink()
    for (waiter in connectWaiters) handler.removeCallbacks(waiter.timer)
    connectWaiters.clear()
    queuedOptions = null
    handler.removeCallbacks(opTimeout)
    queue.clear()
    current = null
    state = State.DISCONNECTED
  }

  private fun closeGatt() {
    callback = null
    clearServiceCaches()
    val gatt = gatt ?: return
    this.gatt = null
    try {
      gatt.disconnect()
    } catch (_: Exception) {}
    try {
      gatt.close()
    } catch (_: Exception) {}
  }

  private fun clearServiceCaches() {
    uuids.clear()
  }

  private fun resetLink() {
    isConnected = false
    discovering = false
    halted = false
    mtu = DEFAULT_MTU
  }

  private fun cancelLookup() {
    lookup?.cancel()
    lookup = null
  }

  private fun setState(next: State) {
    state = next
    delegate.emit("connection", payloadOf("deviceId" to id, "state" to next.label))
  }

  // Queue

  fun enqueue(op: GattOp) {
    if (state != State.CONNECTED) {
      return central.fail(op.opId, central.unavailableError() ?: BleException.notConnected())
    }
    queue.addLast(op)
    startNextOp()
  }

  private fun startNextOp() {
    if (current != null || halted || state != State.CONNECTED) return
    val op = queue.pollFirst() ?: return
    current = op
    if (op.timeout > 0) handler.postDelayed(opTimeout, op.timeout)
    try {
      start(op)
    } catch (error: Exception) {
      failCurrent(BleException.of(error))
    }
  }

  private fun takeCurrent(): GattOp? {
    val op = current ?: return null
    handler.removeCallbacks(opTimeout)
    current = null
    return op
  }

  private fun completeCurrent(value: Any? = null) {
    val op = takeCurrent() ?: return
    if (!op.hasTimedOut && !op.isInternal) central.result(op.opId, value)
    startNextOp()
  }

  private fun failCurrent(error: BleException) {
    val op = takeCurrent() ?: return
    failOp(op, error)
    startNextOp()
  }

  /** Fails `op` unless JS already has its answer or never asked. */
  private fun failOp(op: GattOp, error: BleException) {
    if (!op.hasTimedOut && !op.isInternal) central.fail(op.opId, error)
  }

  private fun failOps(error: BleException) {
    takeCurrent()?.let { failOp(it, error) }
    for (op in queue) failOp(op, error)
    queue.clear()
  }

  /**
   * Ends a link that can no longer be trusted: halts the queue first so nothing more starts on it, then fails the
   * op in flight with `opError`, then disconnects with `reason`. All in one go on this thread, so a call that
   * arrives afterwards finds the connection already disconnected.
   */
  private fun dropLink(opError: BleException, reason: BleException) {
    halted = true
    takeCurrent()?.let { failOp(it, opError) }
    finishDisconnect(reason)
  }

  /**
   * The op fails with `timeout`, but keeps the queue until its callback arrives: Android's callbacks carry no request
   * id, so a late one would otherwise complete the next op. A slow answer is common, for instance a write behind a
   * burst of writes without response that Android buffered. Only an op that stays unanswered for a second timeout
   * means the link is stuck, and resets it.
   */
  private fun onOpTimeout() {
    val op = current ?: return
    val what =
      when (op) {
        is GattOp.Write -> "Write ${op.characteristic} (${op.value.size} B${if (op.withoutResponse) ", without response" else ""})"
        else -> op::class.simpleName
      }
    if (op.hasTimedOut) {
      delegate.log(LogLevel.WARN, "Operation $what still unanswered after twice ${op.timeout} ms; disconnecting", id)
      return dropLink(
        BleException.timeout(),
        BleException("timeout", "An operation never answered, so the connection was reset"),
      )
    }
    delegate.log(LogLevel.WARN, "Operation $what timed out after ${op.timeout} ms; waiting for its late answer", id)
    failOp(op, BleException.timeout())
    op.hasTimedOut = true
    handler.postDelayed(opTimeout, op.timeout)
  }

  private fun uuidOf(value: String): UUID = uuids.getOrPut(value) { Uuids.parse(value) }

  private fun characteristicOf(service: String, characteristic: String): BluetoothGattCharacteristic {
    val gatt = gatt ?: throw BleException.notConnected()
    val found = gatt.getService(uuidOf(service))?.getCharacteristic(uuidOf(characteristic))
    return found ?: throw BleException("not-found", "No characteristic $characteristic in service $service")
  }

  private fun descriptorOf(service: String, characteristic: String, descriptor: String): BluetoothGattDescriptor =
    characteristicOf(service, characteristic).getDescriptor(uuidOf(descriptor))
      ?: throw BleException("not-found", "No descriptor $descriptor on characteristic $characteristic")

  private fun startFailed(what: String): Nothing = throw BleException.gatt("$what could not start", null)

  /**
   * A start call refused with a `BluetoothStatusCodes` value (API 33+), e.g. 201 when the stack is busy with
   * another write. Those are not ATT statuses, so they get their own domain.
   */
  private fun startRefused(what: String, status: Int): Nothing =
    throw BleException.gatt("$what could not start (status $status)", status, BleException.STATUS_DOMAIN)

  @Suppress("DEPRECATION")
  private fun start(op: GattOp) {
    val gatt = gatt ?: throw BleException.notConnected()
    when (op) {
      is GattOp.Read -> {
        val characteristic = characteristicOf(op.service, op.characteristic)
        if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_READ == 0) {
          throw BleException("not-permitted", "The characteristic cannot be read")
        }
        op.awaiting = characteristic
        if (!gatt.readCharacteristic(characteristic)) startFailed("Read")
      }
      is GattOp.Write -> {
        val characteristic = characteristicOf(op.service, op.characteristic)
        val property =
          if (op.withoutResponse) BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
          else BluetoothGattCharacteristic.PROPERTY_WRITE
        if (characteristic.properties and property == 0) {
          throw BleException("not-permitted", "The characteristic does not support this write")
        }
        val type =
          if (op.withoutResponse) BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
          else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        op.awaiting = characteristic
        if (Build.VERSION.SDK_INT >= 33) {
          val status = gatt.writeCharacteristic(characteristic, op.value, type)
          if (status != BluetoothStatusCodes.SUCCESS) startRefused("Write", status)
        } else {
          // A platform race below API 33, with no sound fix here: the stack writes a notification's value into
          // this same `characteristic.value` on its binder thread, without a lock this code could share. A
          // notification landing between these two lines makes the write send its bytes, and a write landing
          // between the stack's store and the copy in onCharacteristicChanged reports these bytes as the
          // notification. Only a characteristic that both notifies and is written is exposed; API 33+ passes values.
          characteristic.writeType = type
          characteristic.value = op.value
          if (!gatt.writeCharacteristic(characteristic)) startFailed("Write")
        }
      }
      is GattOp.SetNotify -> {
        val characteristic = characteristicOf(op.service, op.characteristic)
        val supported =
          BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE
        if (op.enable && characteristic.properties and supported == 0) {
          throw BleException("not-permitted", "The characteristic has neither notify nor indicate")
        }
        // The listener is always registered: notifications are forwarded once the device sends them.
        if (!gatt.setCharacteristicNotification(characteristic, op.enable)) startFailed("Enabling notifications")
        // Some devices notify without a CCCD; there is nothing more to write.
        val cccd = characteristic.getDescriptor(Uuids.CCCD) ?: return completeCurrent()
        val value =
          when {
            !op.enable -> BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            op.indicate -> BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            else -> BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          }
        op.awaiting = cccd
        writeDescriptor(gatt, cccd, value)
      }
      is GattOp.ReadDescriptor -> {
        val descriptor = descriptorOf(op.service, op.characteristic, op.descriptor)
        op.awaiting = descriptor
        if (!gatt.readDescriptor(descriptor)) startFailed("Descriptor read")
      }
      is GattOp.WriteDescriptor -> {
        if (uuidOf(op.descriptor) == Uuids.CCCD) {
          throw BleException("not-permitted", "Use subscribe() instead of writing the CCCD")
        }
        val descriptor = descriptorOf(op.service, op.characteristic, op.descriptor)
        op.awaiting = descriptor
        writeDescriptor(gatt, descriptor, op.value)
      }
      is GattOp.ReadRssi -> if (!gatt.readRemoteRssi()) startFailed("RSSI read")
      is GattOp.RequestMtu -> {
        if (op.mtu < DEFAULT_MTU || op.mtu > MAX_MTU) {
          throw BleException("invalid-argument", "The MTU must be between $DEFAULT_MTU and $MAX_MTU")
        }
        if (!gatt.requestMtu(op.mtu)) startFailed("MTU request")
      }
      is GattOp.RequestPriority -> {
        if (!gatt.requestConnectionPriority(priorityOf(op.priority))) startFailed("Priority request")
        completeCurrent()
      }
      is GattOp.SetPhy -> {
        if (Build.VERSION.SDK_INT < 26) throw BleException.phyUnsupported()
        // Android reports onPhyUpdate only when a PHY changes, so read the PHYs in use first.
        op.awaiting = AwaitingPhyRead
        gatt.readPhy()
      }
      is GattOp.ReadPhy -> {
        if (Build.VERSION.SDK_INT < 26) throw BleException.phyUnsupported()
        gatt.readPhy()
      }
      is GattOp.RefreshCache -> {
        val refreshed =
          try {
            gatt.javaClass.getMethod("refresh").invoke(gatt) as? Boolean ?: false
          } catch (_: Exception) {
            false
          }
        if (!refreshed) throw BleException.unsupported("This phone does not allow clearing the GATT cache")
        if (!gatt.discoverServices()) startFailed("Service discovery")
      }
      is GattOp.Rediscover -> if (!gatt.discoverServices()) startFailed("Service discovery")
    }
  }

  @Suppress("DEPRECATION")
  private fun writeDescriptor(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, value: ByteArray) {
    if (Build.VERSION.SDK_INT >= 33) {
      val status = gatt.writeDescriptor(descriptor, value)
      if (status != BluetoothStatusCodes.SUCCESS) startRefused("Descriptor write", status)
    } else {
      descriptor.value = value
      if (!gatt.writeDescriptor(descriptor)) startFailed("Descriptor write")
    }
  }

  private fun priorityOf(priority: String) =
    when (priority) {
      "high" -> BluetoothGatt.CONNECTION_PRIORITY_HIGH
      "low-power" -> BluetoothGatt.CONNECTION_PRIORITY_LOW_POWER
      else -> BluetoothGatt.CONNECTION_PRIORITY_BALANCED
    }

  /** Whether `phy` in use is one of `wanted`; a direction not asked for always matches. */
  private fun phyMatches(wanted: List<String>?, phy: Int): Boolean {
    if (wanted.isNullOrEmpty()) return true
    val inUse =
      when (phy) {
        BluetoothDevice.PHY_LE_2M -> BluetoothDevice.PHY_LE_2M_MASK
        BluetoothDevice.PHY_LE_CODED -> BluetoothDevice.PHY_LE_CODED_MASK
        else -> BluetoothDevice.PHY_LE_1M_MASK
      }
    return phyMaskOf(wanted) and inUse != 0
  }

  private fun phyPayload(tx: Int, rx: Int): Map<String, Any?> =
    payloadOf("tx" to (phyNameOf(tx) ?: "le1m"), "rx" to (phyNameOf(rx) ?: "le1m"))

  private fun gattError(what: String, status: Int) = BleException.gatt("$what failed with status $status", status)

  // Callbacks, posted from the binder thread

  private fun onConnectionStateChange(status: Int, newState: Int) {
    delegate.log(LogLevel.DEBUG, "connection state $newState status $status", id)
    when (state) {
      State.CONNECTING ->
        if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
          if (!discovering) onLinkUp()
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
          failConnect(BleException("connection-failed", "The connection failed with status $status", status, BleException.GATT_DOMAIN))
        }
      State.CONNECTED ->
        if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
          finishDisconnect(BleException("disconnected", "The device disconnected with status $status", status, BleException.GATT_DOMAIN))
        }
      State.DISCONNECTING -> if (newState == BluetoothProfile.STATE_DISCONNECTED) finishDisconnect(null)
      State.DISCONNECTED -> Unit
    }
  }

  private fun onMtuChanged(value: Int, status: Int) {
    if (status == BluetoothGatt.GATT_SUCCESS && value != mtu) {
      mtu = value
      delegate.emit("mtu", payloadOf("deviceId" to id, "mtu" to value))
    }
    if (state == State.CONNECTING) return discover()
    if (current !is GattOp.RequestMtu) return
    if (status == BluetoothGatt.GATT_SUCCESS) completeCurrent(value) else failCurrent(gattError("MTU request", status))
  }

  private fun onServicesDiscovered(status: Int) {
    clearServiceCaches()
    if (state == State.CONNECTING) return onConnectDiscoveryFinished(status)
    val op = current
    if (op !is GattOp.RefreshCache && op !is GattOp.Rediscover) return
    if (status != BluetoothGatt.GATT_SUCCESS) return failCurrent(gattError("Service discovery", status))
    completeCurrent(if (op is GattOp.RefreshCache) connectedValue() else servicesValue())
  }

  /** The device's Service Changed indication (API 31+): Android dropped its cached services. JS calls `rediscoverServices`. */
  private fun onServiceChanged() {
    delegate.log(LogLevel.INFO, "The device changed its services", id)
    clearServiceCaches()
    if (state == State.CONNECTED) delegate.emit("servicesChanged", payloadOf("deviceId" to id))
  }

  private fun onCharacteristicRead(characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
    val op = current as? GattOp.Read ?: return
    if (op.awaiting !== characteristic) return
    if (status == BluetoothGatt.GATT_SUCCESS) completeCurrent(value) else failCurrent(gattError("Read", status))
  }

  private fun onCharacteristicWrite(characteristic: BluetoothGattCharacteristic, status: Int) {
    val op = current as? GattOp.Write ?: return
    if (op.awaiting !== characteristic) return
    if (status == BluetoothGatt.GATT_SUCCESS) completeCurrent() else failCurrent(gattError("Write", status))
  }

  private fun onDescriptorRead(descriptor: BluetoothGattDescriptor, value: ByteArray, status: Int) {
    val op = current as? GattOp.ReadDescriptor ?: return
    if (op.awaiting !== descriptor) return
    if (status == BluetoothGatt.GATT_SUCCESS) completeCurrent(value) else failCurrent(gattError("Descriptor read", status))
  }

  private fun onDescriptorWrite(descriptor: BluetoothGattDescriptor, status: Int) {
    val op = current ?: return
    if ((op !is GattOp.SetNotify && op !is GattOp.WriteDescriptor) || op.awaiting !== descriptor) return
    if (status != BluetoothGatt.GATT_SUCCESS) return failCurrent(gattError("Descriptor write", status))
    // JS was told the subscribe timed out, so no one listens: turn notifications back off, before any later op.
    if (op is GattOp.SetNotify && op.enable && op.hasTimedOut) {
      delegate.log(LogLevel.INFO, "A timed-out subscribe to ${op.characteristic} succeeded late; unsubscribing", id)
      queue.addFirst(
        GattOp.SetNotify(op.opId, op.timeout, op.service, op.characteristic, enable = false, indicate = op.indicate).apply {
          isInternal = true
        }
      )
    }
    completeCurrent()
  }

  private fun onRssiRead(rssi: Int, status: Int) {
    if (current !is GattOp.ReadRssi) return
    if (status == BluetoothGatt.GATT_SUCCESS) completeCurrent(rssi) else failCurrent(gattError("RSSI read", status))
  }

  private fun onPhy(tx: Int, rx: Int, status: Int, read: Boolean) {
    when (val op = current) {
      is GattOp.ReadPhy -> if (!read) return
      is GattOp.SetPhy -> {
        // First the read: when the PHYs asked for are already in use no update would come, so answer now.
        if (op.awaiting === AwaitingPhyRead) {
          if (!read) return
          if (status != BluetoothGatt.GATT_SUCCESS) return failCurrent(gattError("PHY read", status))
          if (phyMatches(op.tx, tx) && phyMatches(op.rx, rx)) {
            if (!op.wantsCodedOption) return completeCurrent(phyPayload(tx, rx))
            // The coding (S2/S8) is not reported, so it may differ though the PHYs match: ask for it anyway, then
            // read back, since an update may not come for an unchanged PHY.
            op.awaiting = AwaitingPhyReadBack
            return requestPhy(op, readBack = true)
          }
          op.awaiting = null
          return requestPhy(op, readBack = false)
        }
        // After a request for an unchanged PHY, whichever of the read and an update comes first answers.
        if (read && op.awaiting !== AwaitingPhyReadBack) return
      }
      else -> return
    }
    if (status == BluetoothGatt.GATT_SUCCESS) completeCurrent(phyPayload(tx, rx)) else failCurrent(gattError("PHY", status))
  }

  /** Asks for the PHYs of `op`, then reads them back if `readBack`; onPhyUpdate or onPhyRead completes it. */
  private fun requestPhy(op: GattOp.SetPhy, readBack: Boolean) {
    // Never true at run time ([start] refuses SetPhy below API 26); it tells lint these calls are guarded.
    if (Build.VERSION.SDK_INT < 26) return
    val gatt = gatt ?: return failCurrent(BleException.notConnected())
    val options =
      when (op.codedOption) {
        "s2" -> BluetoothDevice.PHY_OPTION_S2
        "s8" -> BluetoothDevice.PHY_OPTION_S8
        else -> BluetoothDevice.PHY_OPTION_NO_PREFERRED
      }
    try {
      gatt.setPreferredPhy(phyMaskOf(op.tx), phyMaskOf(op.rx), options)
      if (readBack) gatt.readPhy()
    } catch (error: Exception) {
      failCurrent(BleException.of(error))
    }
  }

  private fun onNotification(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
    if (state != State.CONNECTED) return
    delegate.emitNotification(id, Uuids.format(characteristic.service.uuid), Uuids.format(characteristic.uuid), value)
  }

  /**
   * Copies each value at once and posts it; events of a stale gatt are dropped. The `value` arrays of the API 33+
   * overloads need no copy: each is fresh from the binder call, and nothing writes to it afterwards (this library
   * never uses the legacy setters on 33+).
   */
  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  private inner class GattCallback : BluetoothGattCallback() {
    /**
     * Runs `work` on the handler, catching throws so they cannot kill the Bluetooth thread. A throw fails what `work`
     * was settling: the connect while connecting, otherwise the op in flight when `forOp` (event-only callbacks, such
     * as notifications, leave it alone). Inline, so each callback posts one Runnable rather than a lambda inside a
     * wrapper.
     */
    private fun post(forOp: Boolean = true, work: () -> Unit) {
      handler.post {
        if (callback !== this) return@post
        val op = current
        try {
          work()
        } catch (error: Exception) {
          delegate.log(LogLevel.ERROR, "Unexpected failure in a GATT callback: $error", id)
          when {
            state == State.CONNECTING -> failConnect(BleException.of(error))
            forOp && op != null && current === op -> failCurrent(BleException.of(error))
          }
        }
      }
    }

    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) = post {
      onConnectionStateChange(status, newState)
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) = post { onServicesDiscovered(status) }

    override fun onServiceChanged(gatt: BluetoothGatt) = post(forOp = false) { onServiceChanged() }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) = post { onMtuChanged(mtu, status) }

    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      if (Build.VERSION.SDK_INT >= 33) return
      val value = characteristic.value?.copyOf() ?: ByteArray(0)
      post { onCharacteristicRead(characteristic, value, status) }
    }

    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
      status: Int,
    ) {
      post { onCharacteristicRead(characteristic, value, status) }
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) = post {
      onCharacteristicWrite(characteristic, status)
    }

    // Android 13+ calls only the `value` overload, earlier versions only this one; the guard keeps a stack that
    // calls both from reporting a notification twice.
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT >= 33) return
      val value = characteristic.value?.copyOf() ?: return
      post(forOp = false) { onNotification(characteristic, value) }
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      if (Build.VERSION.SDK_INT < 33) return
      post(forOp = false) { onNotification(characteristic, value) }
    }

    override fun onDescriptorRead(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      if (Build.VERSION.SDK_INT >= 33) return
      val value = descriptor.value?.copyOf() ?: ByteArray(0)
      post { onDescriptorRead(descriptor, value, status) }
    }

    override fun onDescriptorRead(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int, value: ByteArray) {
      post { onDescriptorRead(descriptor, value, status) }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) = post {
      onDescriptorWrite(descriptor, status)
    }

    override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) = post { onRssiRead(rssi, status) }

    override fun onPhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) = post {
      onPhy(txPhy, rxPhy, status, read = false)
    }

    override fun onPhyRead(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) = post {
      onPhy(txPhy, rxPhy, status, read = true)
    }
  }

  /** In [GattOp.awaiting]: a [GattOp.SetPhy] waits for its first PHY read. */
  private object AwaitingPhyRead

  /** In [GattOp.awaiting]: a [GattOp.SetPhy] waits for the read after its request. */
  private object AwaitingPhyReadBack

  companion object {
    /** The LE ATT_MTU every link starts with, and the least one can ask for (Core spec, Vol 3 Part G 5.2.1). */
    private const val DEFAULT_MTU = 23
    /** Android's largest MTU (GATT_MAX_MTU_SIZE): a 512-byte value plus a Prepare Write Request's 5-byte header. */
    const val MAX_MTU = 517
  }
}
