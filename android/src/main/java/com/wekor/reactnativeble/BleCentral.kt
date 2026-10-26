package com.wekor.reactnativeble

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.PermissionAwareActivity
import java.util.concurrent.ConcurrentHashMap

/** What the central reports to: the module, which hands events and results to JS through the C++ bridge. */
internal interface BleCentralDelegate {
  /** Any thread; the C++ bridge keeps the order of calls. */
  fun emit(type: String, payload: Map<String, Any?>)

  /**
   * An op's `result` event, `{ opId, value }` or `{ opId, error }`: the bridge builds it, so no Map is made and
   * walked for the envelope. Same queue as `emit`, so results keep their order among events.
   */
  fun emitResult(opId: Double, value: Any?, error: Map<String, Any?>?)

  /** The scan's hot path: one JNI call with typed fields instead of a Map walked field by field. */
  fun emitAdvertisement(advertisement: Advertisement)

  /** A notification, without a Map: the busiest event after advertisements. */
  fun emitNotification(deviceId: String, service: String, characteristic: String, value: ByteArray)

  /** The first [count] bytes of [buffer], which the caller reuses once this returns. */
  fun emitL2capData(channelId: Int, buffer: ByteArray, count: Int)

  /**
   * Any thread. Whether every scan reported the device already and drops whatever else it advertises, so its
   * advertisement need not be built; counts as hearing it.
   */
  fun isDuplicateAdvertisement(deviceId: String): Boolean

  fun log(level: LogLevel, message: String, deviceId: String? = null)
}

/**
 * What all devices share: the thread everything runs on, permission and Bluetooth state, the scanner, bonding,
 * L2CAP channels and the connections, each handed the work for its device. Everything here, in the connections,
 * the scanner and the bonds runs on that one thread, so none of it needs locks; values from Bluetooth callbacks
 * are copied on the calling thread and posted here.
 */
@SuppressLint("MissingPermission")
internal class BleCentral(private val context: ReactApplicationContext, val delegate: BleCentralDelegate) {
  private val thread = HandlerThread("ReactNativeBle").apply { start() }
  val handler = Handler(thread.looper)
  private val mainHandler = Handler(Looper.getMainLooper())

  val appContext: Context = context.applicationContext
  private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  val adapter: BluetoothAdapter? = manager?.adapter

  /** The permissions Bluetooth needs here; declared before `init`, whose state check reads them. */
  private val permissions =
    if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

  val scanner = BleScanner(this)
  val bonds = BleBonds(this)
  val l2cap = BleL2cap(this)
  // Read from the JS thread by `maxWriteLength`.
  private val connections = ConcurrentHashMap<String, BleConnection>()

  /** Pending `requestPermission` ops, answered together: the activity keeps one permission listener at a time. */
  private val permissionWaiters = ArrayList<Double>()

  /** Pending `requestEnable` ops, answered by the activity result. */
  private val enableWaiters = ArrayList<Double>()

  /**
   * The state as the Bluetooth thread last found it, for `getState` to read without asking the system; it changes
   * only together with a `state` event.
   */
  @Volatile var state = "unknown"
    private set

  private val stateReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
        post { onAdapterStateChanged(state) }
      }
    }

  private val activityListener =
    object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != ENABLE_REQUEST_CODE) return
        post { answerEnableWaiters(resultCode == Activity.RESULT_OK) }
      }
    }

  init {
    state = currentState()
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    context.registerSystemReceiver(stateReceiver, filter)
    context.addActivityEventListener(activityListener)
  }

  /**
   * Runs `work` on the Bluetooth thread; always true, the spec's return value. Inline, so each call posts one
   * Runnable rather than a lambda inside a wrapper.
   */
  fun post(work: () -> Unit): Boolean {
    handler.post {
      try {
        work()
      } catch (error: Exception) {
        delegate.log(LogLevel.ERROR, "Unexpected failure: $error")
      }
    }
    return true
  }

  /**
   * [post] for a spec method that answers `opId`: if `work` throws, the op fails with what it threw instead of
   * never settling. JS settles each op once, so a throw after `work` already answered is harmless.
   */
  fun postOp(opId: Double, work: () -> Unit): Boolean {
    handler.post {
      try {
        work()
      } catch (error: Exception) {
        if (error !is BleException) delegate.log(LogLevel.ERROR, "Unexpected failure: $error")
        fail(opId, BleException.of(error))
      }
    }
    return true
  }

  /** Fails `opId` in call order with the other results; for arguments rejected on the JS thread. */
  fun postFail(opId: Double, error: BleException) = post { fail(opId, error) }

  fun setForeground(value: Boolean) {
    post { scanner.setForeground(value) }
  }

  /**
   * The app came to the foreground. A permission granted in the system dialog while the activity was recreated (or
   * in Settings) has no other callback: its requests were answered when the old activity went, so the state JS
   * holds may be stale.
   */
  fun onHostResume() {
    post {
      scanner.setForeground(true)
      updateState()
    }
  }

  /**
   * Module teardown, without waiting on the Bluetooth thread: the teardown is posted, and `quitSafely` lets it run
   * before the thread ends, closing every GATT there. Nothing it emits reaches JS, which is going away; events posted
   * after it find the thread quit and are dropped.
   */
  fun close() {
    try {
      context.unregisterReceiver(stateReceiver)
    } catch (_: IllegalArgumentException) {}
    context.removeActivityEventListener(activityListener)
    post {
      scanner.close()
      for (connection in connections.values) connection.close()
      connections.clear()
      l2cap.closeAll(null)
      bonds.close()
      // JS is going away; answer what the activity would have, so no op is left waiting on it.
      answerPermissionWaiters()
      answerEnableWaiters(adapter?.isEnabled == true)
    }
    thread.quitSafely()
  }

  // Results

  fun result(opId: Double, value: Any? = null) {
    delegate.emitResult(opId, value, null)
  }

  fun fail(opId: Double, error: BleException) {
    delegate.log(LogLevel.DEBUG, "op ${opId.toLong()} failed: ${error.code} ${error.message}")
    delegate.emitResult(opId, null, error.toPayload())
  }

  // Permissions and state

  private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  fun hasPermission() = permissions.all(::granted)

  fun hasConnectPermission() = Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT)

  fun hasScanPermission() =
    granted(if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_SCAN else Manifest.permission.ACCESS_FINE_LOCATION)

  private val preferences
    get() = context.getSharedPreferences("com.wekor.reactnativeble", Context.MODE_PRIVATE)

  fun currentState(): String {
    val adapter = adapter ?: return "unsupported"
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return "unsupported"
    if (!hasPermission()) return "unauthorized"
    return when (adapter.state) {
      BluetoothAdapter.STATE_ON -> "on"
      BluetoothAdapter.STATE_TURNING_ON -> "turning-on"
      BluetoothAdapter.STATE_TURNING_OFF -> "turning-off"
      BluetoothAdapter.STATE_OFF -> "off"
      else -> "unknown"
    }
  }

  /**
   * Expo's `PermissionResponse`. Android cannot tell a permission never asked for from a denied one, so whether
   * the app asked is remembered; after a denial, the system shows the prompt again only while it would show a
   * rationale.
   */
  fun permissionResponse(): Map<String, Any?> {
    val status =
      when {
        hasPermission() -> "granted"
        preferences.getBoolean(PERMISSION_REQUESTED_KEY, false) -> "denied"
        else -> "undetermined"
      }
    val activity = context.currentActivity
    val canAskAgain =
      status != "denied" || activity == null ||
        permissions.any { !granted(it) && activity.shouldShowRequestPermissionRationale(it) }
    return payloadOf("status" to status, "canAskAgain" to canAskAgain)
  }

  fun requestPermission(opId: Double) {
    val current = permissionResponse()
    if (hasPermission() || current["canAskAgain"] == false) return result(opId, current)
    val activity =
      context.currentActivity as? PermissionAwareActivity
        ?: return fail(opId, BleException("unknown", "No activity to ask for permission from"))
    permissionWaiters.add(opId)
    // A second request would replace the first one's listener; it shares the prompt already showing instead.
    if (permissionWaiters.size > 1) return
    mainHandler.post {
      try {
        if ((activity as? Activity)?.let(::isGone) == true) {
          // Gone before the prompt could show: no one will answer it.
          post { answerPermissionWaiters() }
        } else {
          activity.requestPermissions(permissions, PERMISSION_REQUEST_CODE) { requestCode, _, _ ->
            if (requestCode != PERMISSION_REQUEST_CODE) return@requestPermissions false
            post {
              preferences.edit().putBoolean(PERMISSION_REQUESTED_KEY, true).apply()
              // The state first, so JS has it when the request settles.
              updateState()
              answerPermissionWaiters()
            }
            true
          }
        }
      } catch (error: Exception) {
        post { failPermissionWaiters(BleException("unknown", "Could not ask for permission: $error")) }
      }
    }
  }

  private fun isGone(activity: Activity) = activity.isFinishing || activity.isDestroyed

  private fun answerPermissionWaiters() {
    if (permissionWaiters.isEmpty()) return
    val response = permissionResponse()
    for (opId in permissionWaiters) result(opId, response)
    permissionWaiters.clear()
  }

  private fun failPermissionWaiters(error: BleException) {
    for (opId in permissionWaiters) fail(opId, error)
    permissionWaiters.clear()
  }

  /**
   * The activity is gone, and with it any permission listener or pending activity result: answer with how things
   * stand now rather than wait for a callback that will not come.
   */
  fun onActivityDestroyed() {
    post {
      updateState()
      answerPermissionWaiters()
      answerEnableWaiters(adapter?.isEnabled == true)
    }
  }

  private fun onAdapterStateChanged(state: Int) {
    if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) {
      scanner.onBluetoothOff()
      // Ending a connection can remove it from the map.
      connections.values.toList().forEach { it.onBluetoothOff() }
      l2cap.closeAll(BleException.bluetoothOff())
      bonds.onBluetoothOff()
    }
    updateState()
  }

  /** Checks the state with the system and reports a change; turning on or a new permission also shows the bonds. */
  private fun updateState() {
    val next = currentState()
    if (next == state) return
    state = next
    if (next == "on") bonds.refresh()
    delegate.emit("state", payloadOf("state" to next))
  }

  /** The reason work that needs Bluetooth cannot run now, or null. */
  fun unavailableError(): BleException? =
    when {
      adapter == null -> BleException.noBluetooth()
      !hasConnectPermission() -> BleException.unauthorized()
      !adapter.isEnabled -> BleException.bluetoothOff()
      else -> null
    }

  fun remoteDevice(id: String): BluetoothDevice? =
    try {
      adapter?.getRemoteDevice(id)
    } catch (_: IllegalArgumentException) {
      null
    }

  fun requestEnable(opId: Double) {
    val adapter = adapter ?: return fail(opId, BleException.noBluetooth())
    if (adapter.isEnabled) return result(opId, true)
    if (!hasConnectPermission()) return fail(opId, BleException.unauthorized())
    val activity = context.currentActivity ?: return fail(opId, BleException("unknown", "No activity to show the dialog from"))
    enableWaiters.add(opId)
    if (enableWaiters.size > 1) return
    mainHandler.post {
      try {
        if (isGone(activity)) post { answerEnableWaiters(adapter.isEnabled) }
        else activity.startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), ENABLE_REQUEST_CODE)
      } catch (error: Exception) {
        post { failEnableWaiters(BleException("unknown", "Could not ask to turn Bluetooth on: $error")) }
      }
    }
  }

  private fun answerEnableWaiters(enabled: Boolean) {
    for (opId in enableWaiters) result(opId, enabled)
    enableWaiters.clear()
  }

  private fun failEnableWaiters(error: BleException) {
    for (opId in enableWaiters) fail(opId, error)
    enableWaiters.clear()
  }

  private fun devicesPayload(devices: Collection<BluetoothDevice>) =
    devices.map { device ->
      payloadOf("id" to device.address, "name" to (scanner.nameOf(device.address) ?: nameOrNull(device)))
    }

  /**
   * `device` as the stack knows it, with its address type, so connecting by address works: the scanned device if it
   * was scanned since Bluetooth turned on, `device` itself if it is bonded or connected by some app, otherwise null.
   */
  fun deviceForDirectConnect(device: BluetoothDevice): BluetoothDevice? {
    scanner.seenDevice(device.address)?.let { return it }
    return try {
      val connected = manager?.getConnectionState(device, BluetoothProfile.GATT) == BluetoothProfile.STATE_CONNECTED
      if (device.bondState == BluetoothDevice.BOND_BONDED || connected) device else null
    } catch (_: SecurityException) {
      null
    }
  }

  fun nameOrNull(device: BluetoothDevice): String? =
    try {
      device.name
    } catch (_: SecurityException) {
      null
    }

  fun getConnectedDevices(opId: Double) {
    unavailableError()?.let { return fail(opId, it) }
    result(opId, devicesPayload(manager?.getConnectedDevices(BluetoothProfile.GATT).orEmpty()))
  }

  fun getBondedDevices(opId: Double) {
    unavailableError()?.let { return fail(opId, it) }
    val bonded = adapter?.bondedDevices.orEmpty().filter { it.type != BluetoothDevice.DEVICE_TYPE_CLASSIC }
    result(opId, devicesPayload(bonded))
  }

  // Connections

  fun connectionOf(id: String): BleConnection? = connections[id]

  fun connect(opId: Double, id: String, options: ConnectOptions) {
    unavailableError()?.let { return fail(opId, it) }
    val connection =
      connections[id]
        ?: run {
          val device = remoteDevice(id) ?: return fail(opId, BleException.deviceNotFound(id))
          BleConnection(this, device).also { connections[id] = it }
        }
    connection.connect(opId, options)
  }

  /** Called by a connection that is closed with nothing waiting on it; a later connect makes a new one. */
  fun onConnectionIdle(connection: BleConnection) {
    connections.remove(connection.id, connection)
  }

  fun disconnect(opId: Double, id: String) {
    val connection = connections[id] ?: return result(opId)
    connection.disconnect(opId)
  }

  fun enqueue(id: String, op: GattOp) {
    val connection = connections[id] ?: return fail(op.opId, unavailableError() ?: BleException.notConnected())
    connection.enqueue(op)
  }

  fun maxWriteLength(id: String, withoutResponse: Boolean): Int {
    val connection = connections[id] ?: return 0
    if (!connection.isConnected) return 0
    // An attribute value is at most 512 bytes (Core spec, Vol 3 Part F 3.2.9), however large the MTU; Android
    // refuses longer ones.
    return if (withoutResponse) minOf(connection.mtu - 3, MAX_ATTRIBUTE_LENGTH) else MAX_ATTRIBUTE_LENGTH
  }

  companion object {
    private const val PERMISSION_REQUEST_CODE = 0xB1E
    private const val ENABLE_REQUEST_CODE = 0xB1F
    private const val PERMISSION_REQUESTED_KEY = "permissionRequested"
    private const val MAX_ATTRIBUTE_LENGTH = 512
  }
}
