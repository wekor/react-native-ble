import CoreBluetooth
import Foundation

/// One open L2CAP channel: reading, writing with a buffer for what the stream has no room for yet, and closing.
/// Its streams are scheduled on the central's queue, so they share its threading; opening it is its connection's work.
final class L2capChannel: NSObject, StreamDelegate {
  let id: Int
  let deviceId: String
  /// Holding it keeps the channel open.
  private let cbChannel: CBL2CAPChannel
  private weak var central: BleCentral?
  private let input: InputStream
  private let output: OutputStream
  /// A slice, so taking the first write is O(1); emptied, it is replaced, letting go of the writes already taken.
  private var pendingWrites: ArraySlice<(opId: Double, data: Data, offset: Int)> = []
  /// Bytes taken per `read`. Each read becomes one `l2capData` event and the loop drains the stream, so this only
  /// sets how a burst is chunked: one memory page keeps a burst to few events at little memory per channel.
  private static let readSize = 4096
  private var readBuffer = [UInt8](repeating: 0, count: L2capChannel.readSize)
  private var isClosed = false

  /// Nil when the channel came without its streams, which leaves nothing to use it with.
  init?(id: Int, deviceId: String, channel: CBL2CAPChannel, central: BleCentral) {
    guard let input = channel.inputStream, let output = channel.outputStream else { return nil }
    self.id = id
    self.deviceId = deviceId
    self.cbChannel = channel
    self.central = central
    self.input = input
    self.output = output
  }

  func open(on queue: DispatchQueue) {
    input.delegate = self
    output.delegate = self
    CFReadStreamSetDispatchQueue(input as CFReadStream, queue)
    CFWriteStreamSetDispatchQueue(output as CFWriteStream, queue)
    input.open()
    output.open()
  }

  func write(_ opId: Double, _ data: Data) {
    pendingWrites.append((opId, data, 0))
    flush()
  }

  private func flush() {
    while !pendingWrites.isEmpty, output.hasSpaceAvailable {
      let first = pendingWrites.startIndex
      let (opId, data, offset) = pendingWrites[first]
      let written = data.withUnsafeBytes { buffer -> Int in
        guard let base = buffer.bindMemory(to: UInt8.self).baseAddress else { return 0 }
        return output.write(base + offset, maxLength: data.count - offset)
      }
      if written < 0 {
        central?.close(self, failure: streamFailure(output))
        return
      }
      if offset + written >= data.count {
        pendingWrites.removeFirst()
        if pendingWrites.isEmpty { pendingWrites = [] }
        central?.result(opId)
      } else {
        pendingWrites[first].offset = offset + written
        if written == 0 { return }
      }
    }
  }

  func stream(_ stream: Stream, handle event: Stream.Event) {
    guard !isClosed else { return }
    switch event {
    case .hasBytesAvailable:
      guard let central else { return }
      while input.hasBytesAvailable {
        let count = input.read(&readBuffer, maxLength: readBuffer.count)
        if count <= 0 { break }
        readBuffer.withUnsafeBytes { central.emitL2capData(id, UnsafeRawBufferPointer(rebasing: $0[0..<count])) }
      }
    case .hasSpaceAvailable:
      flush()
    case .errorOccurred:
      central?.close(self, failure: streamFailure(stream))
    case .endEncountered:
      central?.close(self, failure: BleError("disconnected", "The device closed the channel"))
    default:
      break
    }
  }

  private func streamFailure(_ stream: Stream) -> BleError {
    BleError("disconnected", stream.streamError?.localizedDescription ?? "The channel failed")
  }

  /// Closes the streams and returns the ops of the writes still pending, for the caller to fail.
  func close() -> [Double] {
    guard !isClosed else { return [] }
    isClosed = true
    for stream in [input, output] as [Stream] {
      stream.delegate = nil
      stream.close()
    }
    CFReadStreamSetDispatchQueue(input as CFReadStream, nil)
    CFWriteStreamSetDispatchQueue(output as CFWriteStream, nil)
    let pending = pendingWrites.map(\.opId)
    pendingWrites = []
    return pending
  }
}
