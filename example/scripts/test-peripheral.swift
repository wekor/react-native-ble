// A BLE peripheral for testing the library, run on a Mac: `example/scripts/test-peripheral.sh` builds it as an app
// and starts it. The example app's test suite and benchmarks run against it.
//
// Service 8E1A0000-6C1F-4B8F-9D3C-5A0B1C2D3E4F:
//   0001 STREAM    notify        `CONTROL 1` sends `count` notifications of `size` bytes
//   0002 SINK      write w/o r.  counts what arrives
//   0003 CONTROL   write, read   commands below; a read returns SINK stats [packets, bytes, outOfOrder, spanMs] (u32)
//   0004 SINK_ACK  write         like SINK, with responses
//   0005 INDICATE  indicate      `CONTROL 3` sends `count` indications of `size` bytes
//   0006 PATTERN   read          512 bytes, byte i = i & 0xff; descriptor 2901 "Pattern"
//   0007 COUNTER   read          u32 that grows by one on every read
//   0008 ECHO      write, read   returns what was last written
//   0009 ERROR     read          always answers ATT error 0x0E (unlikely error)
//   000A ENCRYPTED read          needs an encrypted link, so reading it pairs
//   000B PSM       read          u16 PSM of an L2CAP channel that echoes what it receives
//   000C SLOW      read          answers after the delay `CONTROL 8` set (default 1500 ms)
//   000D NEVER     read          never answers
//   000E FILE      write w/o r., read  takes a file in chunks; a read returns [received bytes, CRC-32] (u32)
//   000F PING      write w/o r., notify  notifies each write straight back, for round-trip latency
// Service 8E1A1000-6C1F-4B8F-9D3C-5A0B1C2D3E4F, added by `CONTROL 4`:
//   1001 EXTRA     read          "extra"
// Commands written to CONTROL: [1, count u32, size u16] stream notifications · [2] reset SINK ·
// [3, count u32, size u16] stream indications · [4] add the extra service · [5] remove it ·
// [6, ms u32] stop advertising for ms · [8, ms u32] set SLOW's delay · [9] start a new FILE ·
// [10, count u32] have the next L2CAP channel send `count` bytes, byte i = i & 0xff, as soon as it opens ·
// [11, count u32] have the next L2CAP channel discard the first `count` bytes it receives, then send one byte.
// Every streamed packet and SINK write starts with its sequence number (u32 little-endian).
// macOS ends a connection that has gone about 10 s without traffic or a subscription; the app connects again.

import CoreBluetooth
import Foundation

func uuid(_ suffix: String) -> CBUUID { CBUUID(string: "8E1A\(suffix)-6C1F-4B8F-9D3C-5A0B1C2D3E4F") }

let serviceUuid = uuid("0000")
let extraServiceUuid = uuid("1000")

extension Data {
  func u32(_ at: Int) -> UInt32 {
    guard count >= at + 4 else { return 0 }
    return (0..<4).reduce(0) { $0 | UInt32(self[startIndex + at + $1]) << (8 * $1) }
  }

  mutating func appendU32(_ value: UInt32) {
    for shift in stride(from: 0, to: 32, by: 8) { append(UInt8((value >> UInt32(shift)) & 0xff)) }
  }
}

/// One step of CRC-32 (IEEE 802.3, reflected), the checksum zip and PNG use.
func crc32(_ crc: UInt32, _ data: Data) -> UInt32 {
  var crc = crc
  for byte in data {
    crc ^= UInt32(byte)
    for _ in 0..<8 { crc = crc & 1 == 1 ? (crc >> 1) ^ 0xEDB8_8320 : crc >> 1 }
  }
  return crc
}

final class TestPeripheral: NSObject, CBPeripheralManagerDelegate, StreamDelegate {
  private var manager: CBPeripheralManager!
  private let queue = DispatchQueue(label: "test-peripheral")

  private var stream: CBMutableCharacteristic!
  private var sink: CBMutableCharacteristic!
  private var control: CBMutableCharacteristic!
  private var sinkAck: CBMutableCharacteristic!
  private var indicate: CBMutableCharacteristic!
  private var pattern: CBMutableCharacteristic!
  private var counter: CBMutableCharacteristic!
  private var echo: CBMutableCharacteristic!
  private var error: CBMutableCharacteristic!
  private var encrypted: CBMutableCharacteristic!
  private var psm: CBMutableCharacteristic!
  private var slow: CBMutableCharacteristic!
  private var never: CBMutableCharacteristic!
  private var file: CBMutableCharacteristic!
  private var ping: CBMutableCharacteristic!
  /// Ping replies the notification queue had no room for, sent when it is ready again.
  private var pendingPings: [Data] = []
  private var extraService: CBMutableService!
  private var extraServiceAdded = false

  private let patternValue = Data((0..<512).map { UInt8($0 & 0xff) })
  private var reads: UInt32 = 0
  private var echoValue = Data()
  private var slowDelayMs: UInt32 = 1500
  private var channelPsm: CBL2CAPPSM = 0

  // Streaming
  private var streamTarget: CBMutableCharacteristic?
  private var subscribers: [CBUUID: CBCentral] = [:]
  private var toSend: UInt32 = 0
  private var sent: UInt32 = 0
  private var size = 20
  private var streamStarted = Date()

  // FILE: bytes received and the running CRC-32 (IEEE), before its final inversion
  private var fileBytes: UInt32 = 0
  private var fileCrc: UInt32 = 0xFFFF_FFFF

  // SINK statistics
  private var packets: UInt32 = 0
  private var bytes: UInt32 = 0
  private var outOfOrder: UInt32 = 0
  private var expected: UInt32 = 0
  private var firstWrite: Date?
  private var lastWrite = Date()

  // L2CAP channels stay open until the central closes them; each keeps the echo its output had no room for, and
  // `discard` counts down the bytes it drops instead of echoing. Both settings below apply to the next channel.
  private var channels: [(channel: CBL2CAPChannel, pending: Data, discard: UInt32)] = []
  private var greeting: UInt32 = 0
  private var discard: UInt32 = 0

  override init() {
    super.init()
    manager = CBPeripheralManager(delegate: self, queue: queue)
  }

  /// A fresh set of attributes: CoreBluetooth refuses to add an attribute twice, and every power-on adds them anew.
  private func makeAttributes() {
    stream = CBMutableCharacteristic(type: uuid("0001"), properties: [.notify], value: nil, permissions: [])
    sink = CBMutableCharacteristic(type: uuid("0002"), properties: [.writeWithoutResponse], value: nil, permissions: [.writeable])
    control = CBMutableCharacteristic(type: uuid("0003"), properties: [.write, .read], value: nil, permissions: [.writeable, .readable])
    sinkAck = CBMutableCharacteristic(type: uuid("0004"), properties: [.write], value: nil, permissions: [.writeable])
    indicate = CBMutableCharacteristic(type: uuid("0005"), properties: [.indicate], value: nil, permissions: [])
    pattern = CBMutableCharacteristic(type: uuid("0006"), properties: [.read], value: nil, permissions: [.readable])
    counter = CBMutableCharacteristic(type: uuid("0007"), properties: [.read], value: nil, permissions: [.readable])
    echo = CBMutableCharacteristic(type: uuid("0008"), properties: [.write, .read], value: nil, permissions: [.writeable, .readable])
    error = CBMutableCharacteristic(type: uuid("0009"), properties: [.read], value: nil, permissions: [.readable])
    // A static value: CoreBluetooth answers reads itself, after pairing.
    encrypted = CBMutableCharacteristic(
    type: uuid("000A"), properties: [.read], value: Data("secret".utf8), permissions: [.readEncryptionRequired])
    psm = CBMutableCharacteristic(type: uuid("000B"), properties: [.read], value: nil, permissions: [.readable])
    slow = CBMutableCharacteristic(type: uuid("000C"), properties: [.read], value: nil, permissions: [.readable])
    never = CBMutableCharacteristic(type: uuid("000D"), properties: [.read], value: nil, permissions: [.readable])
    file = CBMutableCharacteristic(
    type: uuid("000E"), properties: [.writeWithoutResponse, .read], value: nil, permissions: [.writeable, .readable])
    ping = CBMutableCharacteristic(type: uuid("000F"), properties: [.writeWithoutResponse, .notify], value: nil, permissions: [.writeable])
    pattern.descriptors = [CBMutableDescriptor(type: CBUUID(string: CBUUIDCharacteristicUserDescriptionString), value: "Pattern")]
    extraService = CBMutableService(type: extraServiceUuid, primary: true)
    extraService.characteristics = [
      CBMutableCharacteristic(type: uuid("1001"), properties: [.read], value: Data("extra".utf8), permissions: [.readable]),
    ]
    extraServiceAdded = false
  }

  // MARK: Setup

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    print("state \(peripheral.state.rawValue)")
    guard peripheral.state == .poweredOn else {
      // Every link is gone, and with it every channel; their streams may never report the end.
      closeChannels()
      return
    }
    // Bluetooth turning off doesn't drop the services and the L2CAP channel published before it; without this they
    // would be added twice, and each power cycle would hold one more PSM until macOS has none left to publish.
    peripheral.removeAllServices()
    unpublishChannel()
    makeAttributes()
    let service = CBMutableService(type: serviceUuid, primary: true)
    service.characteristics = [stream, sink, control, sinkAck, indicate, pattern, counter, echo, error, encrypted, psm, slow, never, file, ping]
    peripheral.add(service)
    peripheral.publishL2CAPChannel(withEncryption: false)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error { return print("add service \(service.uuid) failed: \(error)") }
    guard service.uuid == serviceUuid else { return print("extra service added") }
    advertise()
  }

  private func advertise() {
    manager.startAdvertising([CBAdvertisementDataLocalNameKey: "BLE Test", CBAdvertisementDataServiceUUIDsKey: [serviceUuid]])
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    print(error.map { "advertising failed: \($0)" } ?? "advertising")
  }

  /// Gives back the published PSM; macOS keeps it after the process ends, so `stop` calls this too.
  func unpublishChannel() {
    guard channelPsm != 0 else { return }
    manager.unpublishL2CAPChannel(channelPsm)
    channelPsm = 0
  }

  private func closeChannels() {
    for entry in channels {
      for stream in [entry.channel.inputStream, entry.channel.outputStream] as [Stream?] {
        stream?.delegate = nil
        stream?.close()
      }
    }
    channels = []
  }

  /// Ends the process after giving back the PSM, on the manager's queue so it doesn't race a callback.
  func stop() {
    queue.async { [self] in
      unpublishChannel()
      print("stopped")
      exit(0)
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didPublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
    if let error { return print("L2CAP publish failed: \(error)") }
    channelPsm = PSM
    print("L2CAP channel on PSM \(PSM)")
  }

  // MARK: Reads

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    let value: Data
    switch request.characteristic.uuid {
    case pattern.uuid: value = patternValue
    case echo.uuid: value = echoValue
    case psm.uuid:
      value = Data([UInt8(channelPsm & 0xff), UInt8(channelPsm >> 8)])
    case counter.uuid:
      // A long read asks again at an offset; only the first request counts.
      if request.offset == 0 { reads += 1 }
      var data = Data()
      data.appendU32(reads)
      value = data
    case control.uuid:
      var stats = Data()
      stats.appendU32(packets)
      stats.appendU32(bytes)
      stats.appendU32(outOfOrder)
      stats.appendU32(UInt32(firstWrite.map { lastWrite.timeIntervalSince($0) * 1000 } ?? 0))
      value = stats
    case error.uuid:
      return peripheral.respond(to: request, withResult: .unlikelyError)
    case slow.uuid:
      queue.asyncAfter(deadline: .now() + .milliseconds(Int(slowDelayMs))) {
        request.value = Data("slow".utf8)
        peripheral.respond(to: request, withResult: .success)
      }
      return
    case file.uuid:
      var stats = Data()
      stats.appendU32(fileBytes)
      stats.appendU32(~fileCrc)
      value = stats
    case never.uuid:
      return
    default:
      return peripheral.respond(to: request, withResult: .attributeNotFound)
    }
    guard request.offset <= value.count else { return peripheral.respond(to: request, withResult: .invalidOffset) }
    request.value = value.subdata(in: request.offset..<value.count)
    peripheral.respond(to: request, withResult: .success)
  }

  // MARK: Writes

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    for request in requests {
      let value = request.value ?? Data()
      switch request.characteristic.uuid {
      case file.uuid:
        fileBytes += UInt32(value.count)
        fileCrc = crc32(fileCrc, value)
      case sink.uuid, sinkAck.uuid:
        let now = Date()
        if firstWrite == nil { firstWrite = now }
        lastWrite = now
        if value.u32(0) != expected { outOfOrder += 1 }
        expected = value.u32(0) + 1
        packets += 1
        bytes += UInt32(value.count)
      case ping.uuid:
        pendingPings.append(value)
        sendPings()
      case echo.uuid:
        // A long write arrives as several requests with offsets.
        if request.offset == 0 { echoValue = Data() }
        echoValue.append(value)
      case control.uuid:
        handleControl(value)
      default:
        break
      }
    }
    // One answer per batch, to its first request that wants one: writes without response never get one.
    let withoutResponse = [sink.uuid, file.uuid, ping.uuid]
    if let first = requests.first(where: { !withoutResponse.contains($0.characteristic.uuid) }) {
      peripheral.respond(to: first, withResult: .success)
    }
  }

  private func handleControl(_ value: Data) {
    switch value.first {
    case 1, 3:
      streamTarget = value.first == 1 ? stream : indicate
      toSend = value.u32(1)
      size = value.count >= 7 ? Int(value[value.startIndex + 5]) | Int(value[value.startIndex + 6]) << 8 : 20
      sent = 0
      streamStarted = Date()
      print("stream \(toSend) × \(size) B on \(streamTarget!.uuid)")
      pump()
    case 2:
      (packets, bytes, outOfOrder, expected, firstWrite) = (0, 0, 0, 0, nil)
    case 4, 5:
      // After this write's response: the change sends Service Changed, and a central that rediscovers on it (Android,
      // once bonded) fails a write still waiting for its response.
      queue.async { self.setExtraService(added: value.first == 4) }
    case 6:
      let ms = value.u32(1)
      manager.stopAdvertising()
      print("advertising paused for \(ms) ms")
      queue.asyncAfter(deadline: .now() + .milliseconds(Int(ms))) { self.advertise() }
    case 9:
      (fileBytes, fileCrc) = (0, 0xFFFF_FFFF)
    case 8:
      slowDelayMs = value.u32(1)
    case 10:
      greeting = value.u32(1)
    case 11:
      discard = value.u32(1)
    default:
      break
    }
  }

  /// Adding or removing twice is a no-op, so a test that failed halfway leaves nothing behind.
  private func setExtraService(added: Bool) {
    guard added != extraServiceAdded else { return }
    extraServiceAdded = added
    if added {
      manager.add(extraService)
    } else {
      manager.remove(extraService)
      print("extra service removed")
    }
  }

  // MARK: Streaming

  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    subscribers[characteristic.uuid] = central
    print("subscribed to \(characteristic.uuid); max update \(central.maximumUpdateValueLength) B")
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    subscribers[characteristic.uuid] = nil
    if streamTarget?.uuid == characteristic.uuid { toSend = 0 }
  }

  /// Sends until CoreBluetooth's queue is full; `peripheralManagerIsReady` continues.
  private func pump() {
    guard let target = streamTarget, let subscriber = subscribers[target.uuid] else { return }
    let length = max(4, min(size, subscriber.maximumUpdateValueLength))
    while sent < toSend {
      var packet = Data(capacity: length)
      packet.appendU32(sent)
      packet.append(Data(count: length - 4))
      if !manager.updateValue(packet, for: target, onSubscribedCentrals: [subscriber]) { return }
      sent += 1
    }
    if toSend > 0 {
      print("streamed \(sent) × \(length) B in \(Int(Date().timeIntervalSince(streamStarted) * 1000)) ms")
      toSend = 0
    }
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    sendPings()
    pump()
  }

  /// Ping replies go before any stream, in the order the pings came.
  private func sendPings() {
    while let reply = pendingPings.first {
      if !manager.updateValue(reply, for: ping, onSubscribedCentrals: nil) { return }
      pendingPings.removeFirst()
    }
  }

  // MARK: L2CAP echo

  func peripheralManager(_ peripheral: CBPeripheralManager, didOpen channel: CBL2CAPChannel?, error: Error?) {
    guard let channel, let input = channel.inputStream, let output = channel.outputStream else {
      return print("L2CAP open failed: \(error.map { "\($0)" } ?? "no channel")")
    }
    // The greeting waits in `pending` like an echo; the output's first `hasSpaceAvailable` sends it.
    channels.append((channel, Data((0..<Int(greeting)).map { UInt8($0 & 0xff) }), discard))
    (greeting, discard) = (0, 0)
    // On the manager's queue, like every other callback, so the channel list has one thread.
    input.delegate = self
    output.delegate = self
    CFReadStreamSetDispatchQueue(input as CFReadStream, queue)
    CFWriteStreamSetDispatchQueue(output as CFWriteStream, queue)
    input.open()
    output.open()
    print("L2CAP channel opened")
  }

  func stream(_ stream: Stream, handle event: Stream.Event) {
    guard let index = channels.firstIndex(where: { $0.channel.inputStream === stream || $0.channel.outputStream === stream })
    else { return }
    switch event {
    case .hasBytesAvailable:
      guard let input = stream as? InputStream else { return }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while input.hasBytesAvailable {
        let count = input.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        let dropped = min(UInt32(count), channels[index].discard)
        if dropped > 0 {
          channels[index].discard -= dropped
          if channels[index].discard == 0 { channels[index].pending.append(1) }
        }
        channels[index].pending.append(contentsOf: buffer[Int(dropped)..<count])
      }
      flush(index)
    case .hasSpaceAvailable:
      flush(index)
    case .endEncountered, .errorOccurred:
      // Closed, or its stale streams keep the next channel's output from reporting space.
      for stream in [channels[index].channel.inputStream, channels[index].channel.outputStream] as [Stream?] {
        stream?.delegate = nil
        stream?.close()
      }
      channels.remove(at: index)
      print("L2CAP channel closed")
    default:
      break
    }
  }

  /// Writes as much pending echo as the output takes; `hasSpaceAvailable` brings the rest.
  private func flush(_ index: Int) {
    guard let output = channels[index].channel.outputStream else { return }
    while !channels[index].pending.isEmpty && output.hasSpaceAvailable {
      let written = channels[index].pending.withUnsafeBytes {
        output.write($0.bindMemory(to: UInt8.self).baseAddress!, maxLength: $0.count)
      }
      if written <= 0 { break }
      channels[index].pending.removeFirst(written)
    }
  }
}

// Line by line even into a pipe, so a log shows progress as it happens.
setvbuf(stdout, nil, _IOLBF, 0)
let peripheral = TestPeripheral()
// test-peripheral.sh ends a running copy with SIGTERM: give the PSM back first.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let stopSignals = [SIGTERM, SIGINT].map { number in
  let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
  source.setEventHandler { peripheral.stop() }
  source.resume()
  return source
}
RunLoop.main.run()
