package com.wekor.reactnativeble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import java.util.concurrent.ConcurrentHashMap

/**
 * Bonding: `bond()` and `unbond()` settle on the system's bond state broadcasts, Bluetooth turning off, or module
 * teardown. Pairing may wait on the user confirming a dialog or typing a passkey; a pairing the system gives up on
 * ends with BOND_NONE, so no timer is needed.
 */
@SuppressLint("MissingPermission")
internal class BleBonds(private val central: BleCentral) {
  private class Waiter(val opId: Double, val deviceId: String)

  private val bondWaiters = ArrayList<Waiter>()
  private val unbondWaiters = ArrayList<Waiter>()

  /** Bond states by address, other than none, for `getBondState` to read without asking the system. */
  private val states = ConcurrentHashMap<String, String>()

  private val receiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        @Suppress("DEPRECATION")
        val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
        val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
        val address = device.address
        central.post { onBondStateChanged(address, state) }
      }
    }

  init {
    val filter = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
    central.appContext.registerSystemReceiver(receiver, filter)
    central.post { refresh() }
  }

  /** Takes the bonds from the system: the broadcasts only tell of changes. */
  fun refresh() {
    val bonded =
      try {
        central.adapter?.bondedDevices.orEmpty()
      } catch (_: SecurityException) {
        // No permission yet; `refresh` runs again once it is granted.
        return
      }
    states.keys.retainAll { address -> states[address] != "bonded" || bonded.any { it.address == address } }
    for (device in bonded) states[device.address] = "bonded"
  }

  fun close() {
    try {
      central.appContext.unregisterReceiver(receiver)
    } catch (_: IllegalArgumentException) {}
    failAll(BleException("cancelled", "The module was invalidated"))
  }

  /** No bond state broadcast comes while Bluetooth is off. */
  fun onBluetoothOff() = failAll(BleException.bluetoothOff())

  private fun failAll(error: BleException) {
    val waiters = bondWaiters + unbondWaiters
    bondWaiters.clear()
    unbondWaiters.clear()
    for (waiter in waiters) central.fail(waiter.opId, error)
  }

  fun stateOf(deviceId: String): String = states[deviceId] ?: "none"

  private fun labelOf(state: Int) =
    when (state) {
      BluetoothDevice.BOND_BONDED -> "bonded"
      BluetoothDevice.BOND_BONDING -> "bonding"
      else -> "none"
    }

  fun bond(opId: Double, deviceId: String) {
    central.unavailableError()?.let { return central.fail(opId, it) }
    val remote = central.remoteDevice(deviceId) ?: return central.fail(opId, BleException.deviceNotFound(deviceId))
    // The scanned device carries its address type: bonding a random-address device by address alone would use the
    // public type. One the stack has no record of can only be tried as public.
    val device = central.deviceForDirectConnect(remote) ?: remote
    if (device.bondState == BluetoothDevice.BOND_BONDED) return central.result(opId)
    bondWaiters.add(Waiter(opId, deviceId))
    if (device.bondState == BluetoothDevice.BOND_BONDING) return
    if (!device.createBond()) settle(bondWaiters, deviceId) { central.fail(it, BleException("bond-failed", "Bonding could not start")) }
  }

  fun unbond(opId: Double, deviceId: String) {
    central.unavailableError()?.let { return central.fail(opId, it) }
    val device = central.remoteDevice(deviceId) ?: return central.fail(opId, BleException.deviceNotFound(deviceId))
    if (device.bondState == BluetoothDevice.BOND_NONE) return central.result(opId)
    // A hidden API: phone makers may remove it.
    val removed =
      try {
        device.javaClass.getMethod("removeBond").invoke(device) as? Boolean ?: false
      } catch (_: Exception) {
        false
      }
    if (!removed) return central.fail(opId, BleException.unsupported("This phone does not allow removing the bond"))
    unbondWaiters.add(Waiter(opId, deviceId))
  }

  private fun onBondStateChanged(deviceId: String, state: Int) {
    if (state == BluetoothDevice.BOND_NONE) states.remove(deviceId) else states[deviceId] = labelOf(state)
    when (state) {
      BluetoothDevice.BOND_BONDED -> settle(bondWaiters, deviceId) { central.result(it) }
      BluetoothDevice.BOND_NONE -> {
        settle(bondWaiters, deviceId) { central.fail(it, BleException("bond-failed", "Pairing failed or was declined")) }
        settle(unbondWaiters, deviceId) { central.result(it) }
      }
    }
  }

  private fun settle(list: ArrayList<Waiter>, deviceId: String, answer: (Double) -> Unit) {
    val matching = list.filter { it.deviceId == deviceId }
    list.removeAll { it.deviceId == deviceId }
    for (waiter in matching) answer(waiter.opId)
  }
}
