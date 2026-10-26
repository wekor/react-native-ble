package com.wekor.reactnativeble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothSocket
import android.os.Build
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * L2CAP channels (API 29+). Sockets block, so connecting, reading and writing run on their own threads; their
 * outcomes are posted back to the Bluetooth thread, which owns the channel table.
 */
@SuppressLint("MissingPermission")
internal class BleL2cap(private val central: BleCentral) {
  private inner class Channel(val id: Int, val deviceId: String, val socket: BluetoothSocket) {
    val writer: ExecutorService = Executors.newSingleThreadExecutor()
    val closed = AtomicBoolean(false)

    fun startReading() {
      Thread({
          val buffer = ByteArray(BUFFER_SIZE)
          try {
            val input = socket.inputStream
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              if (count > 0) central.delegate.emitL2capData(id, buffer, count)
            }
            central.post { end(this, null) }
          } catch (error: IOException) {
            central.post { end(this, channelClosed(error)) }
          }
        }, "ReactNativeBle-l2cap-$id")
        .start()
    }
  }

  /** A channel still connecting; it is pending until it opens, fails, times out, or its link ends. */
  private class Opening(val opId: Double, val deviceId: String, val socket: BluetoothSocket) {
    var expire: Runnable? = null
  }

  private val channels = HashMap<Int, Channel>()
  private val openings = HashSet<Opening>()
  private var nextId = 1

  fun open(opId: Double, deviceId: String, psm: Int, secure: Boolean, timeout: Long) {
    if (Build.VERSION.SDK_INT < 29) return central.fail(opId, BleException.unsupported("L2CAP needs Android 10"))
    central.unavailableError()?.let { return central.fail(opId, it) }
    if (central.connectionOf(deviceId)?.isConnected != true) return central.fail(opId, BleException.notConnected())
    val device = central.remoteDevice(deviceId) ?: return central.fail(opId, BleException.deviceNotFound(deviceId))
    val socket =
      try {
        if (secure) device.createL2capChannel(psm) else device.createInsecureL2capChannel(psm)
      } catch (error: IOException) {
        return central.fail(opId, BleException("connection-failed", "Could not create the channel: ${error.message}"))
      }

    val opening = Opening(opId, deviceId, socket)
    openings.add(opening)
    if (timeout > 0) {
      val expire = Runnable { abandon(opening, BleException("timeout", "The channel did not open in time")) }
      opening.expire = expire
      central.handler.postDelayed(expire, timeout)
    }

    // Each outcome below settles the open only if it is still pending; a channel nobody waits for any more is closed.
    Thread({
        try {
          socket.connect()
          central.post {
            if (!settle(opening)) return@post closeQuietly(socket)
            val channel = Channel(nextId++, deviceId, socket)
            channels[channel.id] = channel
            // The reader emits from its own thread, so it starts after the result: JS knows a channel by its result.
            central.result(opId, payloadOf("channelId" to channel.id))
            channel.startReading()
          }
        } catch (error: IOException) {
          central.post {
            if (!settle(opening)) return@post
            central.fail(opId, BleException("connection-failed", "The channel did not open: ${error.message}"))
          }
        }
      }, "ReactNativeBle-l2cap-connect")
      .start()
  }

  fun write(opId: Double, channelId: Int, value: ByteArray) {
    val channel = channels[channelId] ?: return central.fail(opId, BleException.notConnected())
    channel.writer.execute {
      try {
        with(channel.socket.outputStream) {
          write(value)
          flush()
        }
        central.post { central.result(opId) }
      } catch (error: IOException) {
        central.post {
          central.fail(opId, BleException.disconnected())
          end(channel, channelClosed(error))
        }
      }
    }
  }

  fun close(opId: Double, channelId: Int) {
    channels[channelId]?.let { end(it, null) }
    central.result(opId)
  }

  fun closeFor(deviceId: String) {
    openings.filter { it.deviceId == deviceId }.forEach { abandon(it, BleException.disconnected()) }
    channels.values.filter { it.deviceId == deviceId }.forEach { end(it, BleException.disconnected()) }
  }

  /** Closes every channel and pending open, reporting `reason`; null for module teardown, when no one is left to tell. */
  fun closeAll(reason: BleException?) {
    openings.toList().forEach { abandon(it, reason) }
    channels.values.toList().forEach { end(it, reason, report = reason != null) }
  }

  /** Takes `opening` off the pending ones; false if something else settled it first. */
  private fun settle(opening: Opening): Boolean {
    if (!openings.remove(opening)) return false
    opening.expire?.let { central.handler.removeCallbacks(it) }
    return true
  }

  /** Fails a pending open with `reason` (null tells no one) and closes its socket, which ends its connect. */
  private fun abandon(opening: Opening, reason: BleException?) {
    if (!settle(opening)) return
    closeQuietly(opening.socket)
    reason?.let { central.fail(opening.opId, it) }
  }

  private fun end(channel: Channel, error: BleException?, report: Boolean = true) {
    if (!channel.closed.compareAndSet(false, true)) return
    channels.remove(channel.id)
    closeQuietly(channel.socket)
    channel.writer.shutdown()
    if (report) central.delegate.emit("l2capClosed", payloadOf("channelId" to channel.id, "error" to error?.toPayload()))
  }

  private fun closeQuietly(socket: BluetoothSocket) {
    try {
      socket.close()
    } catch (_: IOException) {}
  }

  private fun channelClosed(error: IOException) = BleException("disconnected", "The channel closed: ${error.message}")

  private companion object {
    const val BUFFER_SIZE = 4096
  }
}
