package com.wekor.reactnativeble

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.os.Build
import java.util.Locale
import java.util.UUID

internal enum class LogLevel(val label: String) {
  DEBUG("debug"),
  INFO("info"),
  WARN("warn"),
  ERROR("error"),
  OFF("off");

  companion object {
    fun of(label: String?) = entries.firstOrNull { it.label == label } ?: WARN
  }
}

/** A failure as JS receives it: a stable error code such as `timeout`, plus the platform's code and domain if any. */
internal class BleException(
  val code: String,
  message: String,
  val nativeCode: Int? = null,
  val nativeDomain: String? = null,
) : Exception(message) {
  fun toPayload(): Map<String, Any?> =
    payloadOf("code" to code, "message" to message, "nativeCode" to nativeCode, "nativeDomain" to nativeDomain)

  companion object {
    /** An ATT status from a GATT callback. */
    const val GATT_DOMAIN = "android.gatt"
    /** An `onScanFailed` error code. */
    const val SCAN_DOMAIN = "android.scan"
    /** A `BluetoothStatusCodes` value a GATT call returned (API 33+). */
    const val STATUS_DOMAIN = "android.status"

    fun gatt(message: String, status: Int?, domain: String = GATT_DOMAIN) = BleException("gatt", message, status, domain)
    fun timeout() = BleException("timeout", "The operation timed out")
    fun deviceNotFound(id: String) = BleException("not-found", "No device with id $id")
    fun noBluetooth() = unsupported("This device has no Bluetooth")
    fun phyUnsupported() = unsupported("PHY needs Android 8.0")
    fun cancelledByDisconnect() = BleException("cancelled", "disconnect() cancelled the connection")
    fun notConnected() = BleException("not-connected", "The device is not connected")
    fun disconnected() = BleException("disconnected", "The device disconnected")
    fun bluetoothOff() = BleException("bluetooth-off", "Bluetooth is off")
    fun unauthorized() = BleException("unauthorized", "Bluetooth permission is not granted")
    fun unsupported(message: String) = BleException("unsupported", message)
    fun valueNotFound() = BleException("invalid-argument", "The value was not found")

    /** Whatever an operation threw, as the error its op fails with. */
    fun of(error: Exception): BleException =
      when (error) {
        is BleException -> error
        is SecurityException -> unauthorized()
        // Android's checks of a value, such as one longer than an attribute can hold.
        is IllegalArgumentException -> BleException("invalid-argument", error.message ?: error.toString())
        else -> BleException("unknown", error.message ?: error.toString())
      }
  }
}

/** A JS object payload; null fields are left out, since JS reads a missing field as absent. */
internal fun payloadOf(vararg fields: Pair<String, Any?>): Map<String, Any?> {
  val map = LinkedHashMap<String, Any?>(fields.size)
  for ((key, value) in fields) if (value != null) map[key] = value
  return map
}

/** Registers a receiver for system broadcasts, which Android 14+ requires to be marked exported. */
internal fun Context.registerSystemReceiver(receiver: BroadcastReceiver, filter: IntentFilter) {
  if (Build.VERSION.SDK_INT >= 34) registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
  else registerReceiver(receiver, filter)
}

/** The `BluetoothDevice.PHY_LE_*_MASK` bits for PHY names; none asked for means LE 1M. */
internal fun phyMaskOf(phys: List<String>?): Int {
  var mask = 0
  for (phy in phys.orEmpty()) {
    mask =
      mask or
        when (phy) {
          "le2m" -> BluetoothDevice.PHY_LE_2M_MASK
          "coded" -> BluetoothDevice.PHY_LE_CODED_MASK
          else -> BluetoothDevice.PHY_LE_1M_MASK
        }
  }
  return if (mask == 0) BluetoothDevice.PHY_LE_1M_MASK else mask
}

/** The name of a `BluetoothDevice.PHY_LE_*` value, or null for none (e.g. an unused secondary PHY). */
internal fun phyNameOf(phy: Int): String? =
  when (phy) {
    BluetoothDevice.PHY_LE_1M -> "le1m"
    BluetoothDevice.PHY_LE_2M -> "le2m"
    BluetoothDevice.PHY_LE_CODED -> "coded"
    else -> null
  }

internal object Uuids {
  private const val BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb"

  fun format(uuid: UUID): String = uuid.toString().lowercase(Locale.ROOT)

  /** JS sends lowercase 128-bit UUIDs; short forms are accepted anyway. */
  fun parse(value: String): UUID {
    val hex = value.lowercase(Locale.ROOT)
    return when (hex.length) {
      4 -> UUID.fromString("0000$hex$BASE_SUFFIX")
      8 -> UUID.fromString("$hex$BASE_SUFFIX")
      else -> UUID.fromString(hex)
    }
  }

  val CCCD: UUID = parse("2902")
}

internal fun servicesPayload(gatt: BluetoothGatt, only: Set<UUID>?): List<Any?> =
  gatt.services.filter { only == null || it.uuid in only }.map(::servicePayload)

private fun servicePayload(service: BluetoothGattService): Map<String, Any?> =
  payloadOf(
    "uuid" to Uuids.format(service.uuid),
    "isPrimary" to (service.type == BluetoothGattService.SERVICE_TYPE_PRIMARY),
    "characteristics" to service.characteristics.map(::characteristicPayload),
  )

private fun characteristicPayload(characteristic: BluetoothGattCharacteristic): Map<String, Any?> {
  val properties = characteristic.properties
  fun has(bit: Int) = properties and bit != 0
  return payloadOf(
    "uuid" to Uuids.format(characteristic.uuid),
    "properties" to
      payloadOf(
        "broadcast" to has(BluetoothGattCharacteristic.PROPERTY_BROADCAST),
        "read" to has(BluetoothGattCharacteristic.PROPERTY_READ),
        "writeWithoutResponse" to has(BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE),
        "write" to has(BluetoothGattCharacteristic.PROPERTY_WRITE),
        "notify" to has(BluetoothGattCharacteristic.PROPERTY_NOTIFY),
        "indicate" to has(BluetoothGattCharacteristic.PROPERTY_INDICATE),
        "authenticatedSignedWrites" to has(BluetoothGattCharacteristic.PROPERTY_SIGNED_WRITE),
        "extendedProperties" to has(BluetoothGattCharacteristic.PROPERTY_EXTENDED_PROPS),
      ),
    "descriptors" to characteristic.descriptors.map { Uuids.format(it.uuid) },
  )
}
