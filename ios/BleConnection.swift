import CoreBluetooth
import Foundation

private let deviceDisconnected = BleError("disconnected", "The device disconnected")

/// One GATT operation; a device runs one at a time, in order.
final class GattOp {
  enum Kind {
    case read(CBCharacteristic)
    case write(CBCharacteristic, Data, withoutResponse: Bool)
    case notify(CBCharacteristic, enable: Bool)
    case readDescriptor(CBDescriptor)
    case writeDescriptor(CBDescriptor, Data)
    case readRssi
    case discover
  }

  let opId: Double
  let timeout: Double
  /// Finds the attribute when the op starts, so it sees the services as they are then: after a `discover`
  /// queued before it, or after a Service Changed indication invalidated the objects found earlier.
  let build: (Connection) throws(BleError) -> Kind
  /// Set once the op starts.
  var kind: Kind?
  /// When it times out, once it waits for a callback.
  var deadline: DispatchTime?
  /// JS has its answer already: the op timed out and now only waits for its late callback.
  var hasTimedOut = false
  /// Queued by the connection itself, not by JS: nothing is answered for it.
  var isInternal = false

  init(opId: Double, timeout: Double, build: @escaping (Connection) throws(BleError) -> Kind) {
    self.opId = opId
    self.timeout = timeout
    self.build = build
  }
}

/// What `connect()` asks for, read once from JS's options.
struct ConnectOptions {
  /// JS always sends one, its configured default when the caller gave none.
  let timeout: Double?
  /// Nil discovers every service.
  let services: [CBUUID]?
  /// The options `CBCentralManager.connect` takes.
  let peripheralOptions: [String: Any]

  private static let flags = [
    ("notifyOnConnection", CBConnectPeripheralOptionNotifyOnConnectionKey),
    ("notifyOnDisconnection", CBConnectPeripheralOptionNotifyOnDisconnectionKey),
    ("notifyOnNotification", CBConnectPeripheralOptionNotifyOnNotificationKey),
    ("enableTransportBridging", CBConnectPeripheralOptionEnableTransportBridgingKey),
    ("requiresAncs", CBConnectPeripheralOptionRequiresANCS),
  ]

  init(_ options: [String: Any]) {
    timeout = options["timeout"] as? Double
    services = (options["services"] as? [String])?.compactMap(CBUUID.init(validating:))
    let ios = options["ios"] as? [String: Any] ?? [:]
    var peripheralOptions: [String: Any] = [:]
    for (name, key) in Self.flags { peripheralOptions[key] = ios[name] as? Bool }
    if let delay = ios["startDelay"] as? Double, delay > 0 { peripheralOptions[CBConnectPeripheralOptionStartDelayKey] = delay }
    self.peripheralOptions = peripheralOptions
  }
}

/// One `connect()` call, waiting for its connection. Its timer covers the whole wait, wherever it waits.
final class ConnectOp {
  let opId: Double
  let options: ConnectOptions
  var timer: DispatchWorkItem?
  var isAnswered = false

  init(opId: Double, options: ConnectOptions) {
    self.opId = opId
    self.options = options
  }
}

/// A pending `openL2CAPChannel`.
struct PendingL2capOpen {
  let opId: Double
  let psm: CBL2CAPPSM
  let timer: DispatchWorkItem?
}

/// What the synchronous getters read about an established connection.
struct ConnectionSnapshot: Equatable {
  let maxWriteWithoutResponse: Int
  let ancsAuthorized: Bool
}

/// One device, from `connect()` until it is fully disconnected: the connection itself, service discovery, the GATT
/// queue with its timeouts, and opening L2CAP channels. It is its peripheral's delegate, so the peripheral's
/// callbacks come straight here. Everything runs on the central's queue; results, events and the snapshots for
/// synchronous getters go through the central. Holding it holds the `CBPeripheral` strongly, which CoreBluetooth
/// requires for the connection to live.
final class Connection: NSObject, CBPeripheralDelegate {
  let id: String
  let peripheral: CBPeripheral
  unowned let central: BleCentral

  /// In the central's connections. Once detached, callbacks still due to it are ignored: a newer connection to
  /// the same device may exist.
  private var isAttached = true

  /// Connect calls waiting for this connection to be ready.
  var connectOps: [ConnectOp] = []
  var servicesToDiscover: [CBUUID]?
  /// Discovery in flight: `discoverServices` calls not answered yet, then the services and characteristics
  /// whose callbacks are still due. By identity, so a callback from discovery that was restarted counts once.
  private var discoveryRequests = 0
  private var pendingServices: Set<ObjectIdentifier> = []
  private var pendingCharacteristics: Set<ObjectIdentifier> = []
  private(set) var isReady = false
  /// CoreBluetooth reported `didConnect` for this attempt: only then is a `didDisconnect` certain to follow a cancel.
  var hasConnected = false
  /// True only while a connection adopted, already connected, from iOS state restoration is still discovering; it
  /// is reported in the `restore` event as well as to `connectOps`.
  var isRestoring = false

  /// We cancelled the connection attempt and wait for CoreBluetooth to confirm before reusing the device.
  private var isClosing = false
  /// Connect calls that arrived while the connection was ending; they start once it has.
  var reconnectOps: [ConnectOp] = []

  private var isDisconnectRequested = false
  private var disconnectOps: [Double] = []
  /// Why we are disconnecting on our own, such as an operation timeout.
  private var disconnectReason: BleError?

  /// A slice, so taking the first op is O(1); emptied, it is replaced, letting go of the ops already taken.
  private var queuedOps: ArraySlice<GattOp> = []
  private var current: GattOp?
  /// Times `current`: one timer for the connection, so ops allocate none and leave nothing scheduled behind them.
  /// Moving it costs more than a short op's other work, so ops never do: it moves only to fire earlier, and when it
  /// fires early for the op now running, it moves on to that op's deadline.
  private var opTimer: DispatchSourceTimer?
  /// When `opTimer` fires; nil when it is not scheduled.
  private var opTimerDue: DispatchTime?
  /// `pump` is running: an op that settles inside it leaves starting the next to that loop instead of recursing.
  private var isPumping = false
  /// A timed-out operation left the connection in an unknown state; nothing else starts.
  private var isHalted = false

  private var pendingL2capOpens: [PendingL2capOpen] = []
  /// What the central last published for the synchronous getters, while established.
  var snapshot: ConnectionSnapshot?

  /// The id and UUIDs a notification carries, as Objective-C strings made once: notifications are the busiest
  /// path after advertisements. Each entry holds its characteristic, so the identifier it is keyed by cannot be
  /// reused while the entry lasts; discovery starting again clears them.
  private let notificationDeviceId: NSString
  private var notificationKeys: [ObjectIdentifier: (characteristic: CBCharacteristic, service: NSString, uuid: NSString)] = [:]
  /// Characteristics found by `characteristic(_:inService:)`, by the strings JS named them with, so repeated
  /// operations neither parse UUIDs nor search the services. Discovery starting again or a Service Changed
  /// indication clears them, with `notificationKeys`.
  private var characteristicCache: [CharacteristicPath: CBCharacteristic] = [:]

  private struct CharacteristicPath: Hashable {
    let service: String
    let characteristic: String
  }

  init(id: String, peripheral: CBPeripheral, central: BleCentral) {
    self.id = id
    self.peripheral = peripheral
    self.central = central
    notificationDeviceId = id as NSString
    super.init()
    peripheral.delegate = self
  }

  deinit {
    opTimer?.cancel()
  }

  var mtu: Int {
    peripheral.state == .connected ? peripheral.maximumWriteValueLength(for: .withoutResponse) + attWriteHeaderLength : defaultAttMtu
  }

  /// What `connect()` answers with.
  var readyPayload: [String: Any] {
    ["mtu": mtu, "services": peripheral.servicesPayload]
  }

  /// Called by the central as it removes this connection: from now on the peripheral's callbacks reach nobody.
  func detach() {
    isAttached = false
    if peripheral.delegate === self { peripheral.delegate = nil }
  }

  // MARK: Connecting

  /// CoreBluetooth connected the peripheral: discover its services next.
  func didConnectPeripheral() {
    guard !isClosing, !isReady else {
      // Connected after the attempt was given up.
      if isClosing { central.manager?.cancelPeripheralConnection(peripheral) }
      return
    }
    central.log(.debug, "connected, discovering", deviceId: id)
    hasConnected = true
    startDiscovery()
  }

  func didFailToConnect(_ error: Error?) {
    if isClosing { return central.finishClose(self) }
    // didFailToConnect can follow didConnect; for a ready connection it is a disconnect.
    if isReady { return end(connectionFailure(error, "disconnected")) }
    failAttempt(connectionFailure(error, "connection-failed"), cancelsPeripheral: false)
  }

  func didDisconnectPeripheral(_ error: Error?) {
    if isClosing { return central.finishClose(self) }
    // A connection that never came up cannot disconnect: this confirms an attempt cancelled before it.
    guard hasConnected else { return }
    guard isReady else { return failAttempt(connectionFailure(error, "connection-failed"), cancelsPeripheral: false) }
    if isDisconnectRequested { return end(nil) }
    // CoreBluetooth names the cause of every disconnect the app did not ask for, except Bluetooth turning off:
    // that one comes without an error, before the state update that says Bluetooth is off.
    let failure = error == nil ? BleError(unavailableIn: .poweredOff) : connectionFailure(error, "disconnected")
    end(disconnectReason ?? failure)
  }

  /// Ends an attempt that never became ready. With `cancelsPeripheral`, also cancels it in CoreBluetooth and, when
  /// the peripheral was connected, waits for `didDisconnect` before the device is reused; a pending attempt ends at
  /// once.
  func failAttempt(_ failure: BleError, cancelsPeripheral: Bool) {
    guard isAttached, !isReady, !isClosing else { return }
    let ops = connectOps
    connectOps = []
    for op in ops { central.settle(op, failure: failure) }
    if isRestoring { central.finishRestore(self, connected: false) }
    central.emitConnection(id, "disconnected")
    guard cancelsPeripheral, peripheral.state != .disconnected, let manager = central.manager else { return central.finishClose(self) }
    manager.cancelPeripheralConnection(peripheral)
    // A connected peripheral always answers the cancel with didDisconnect: wait for it before connecting again.
    // A pending attempt may not answer at all, for instance when cancelled right after `connect`: it ends now,
    // and a late didDisconnect for it reaches a connection that never came up, which ignores it.
    if hasConnected { isClosing = true } else { central.finishClose(self) }
  }

  /// Discovery finished while connecting: the connection is ready.
  private func becomeReady() {
    guard isAttached, !isReady else { return }
    isReady = true
    central.updateConnectionSnapshot(self)
    central.log(.debug, "connected, mtu \(mtu)", deviceId: id)
    let payload = readyPayload
    let ops = connectOps
    connectOps = []
    for op in ops { central.settle(op, with: payload) }
    if isRestoring { return central.finishRestore(self, connected: true) }
    central.emitConnection(id, "connected")
  }

  /// Joins a `connect()` to this connection: answered at once when ready, or when it becomes ready, or after this
  /// connection has ended when it is ending.
  func join(_ ops: [ConnectOp]) {
    if isClosing || isDisconnectRequested || isHalted {
      reconnectOps += ops
    } else if isReady {
      let payload = readyPayload
      for op in ops { central.settle(op, with: payload) }
    } else {
      connectOps += ops
    }
  }

  // MARK: Disconnecting

  func disconnect(_ opId: Double) {
    // Cancel the connect calls queued to reconnect once this connection has ended.
    let cancelled = BleError("cancelled", "Cancelled by disconnect()")
    let waiting = reconnectOps
    reconnectOps = []
    for op in waiting { central.settle(op, failure: cancelled) }
    guard !isClosing else { return central.result(opId) }
    guard isReady else {
      failAttempt(cancelled, cancelsPeripheral: true)
      return central.result(opId)
    }
    disconnectOps.append(opId)
    // Already ending, by an earlier request or by `drop` (whose reason `onDisconnect` reports): answered when it ends.
    if isDisconnectRequested || disconnectReason != nil { return }
    isDisconnectRequested = true
    central.emitConnection(id, "disconnecting")
    // CoreBluetooth always answers with didDisconnect; Bluetooth turning off ends the connection too.
    central.manager?.cancelPeripheralConnection(peripheral)
  }

  /// Disconnects on our own, reporting `reason` to `onDisconnect`.
  private func drop(_ reason: BleError) {
    guard isReady, !isDisconnectRequested, disconnectReason == nil else { return }
    // Halt first, so settling the current operation does not start the next on a connection about to close.
    isHalted = true
    disconnectReason = reason
    central.emitConnection(id, "disconnecting")
    central.manager?.cancelPeripheralConnection(peripheral)
  }

  /// Ends the established connection: fails its work, reports why, and lets go of the peripheral.
  private func end(_ reason: BleError?) {
    guard isAttached else { return }
    central.remove(self)
    // Operations cut off by Bluetooth turning off say so; to them any other end is a disconnect.
    let failure = if let reason, reason.code == "bluetooth-off" { reason } else { deviceDisconnected }
    if let current, !current.hasTimedOut, !current.isInternal { central.fail(current.opId, failure) }
    for op in queuedOps where !op.hasTimedOut && !op.isInternal { central.fail(op.opId, failure) }
    current = nil
    queuedOps = []
    for open in pendingL2capOpens {
      open.timer?.cancel()
      central.fail(open.opId, failure)
    }
    pendingL2capOpens = []
    central.closeChannels(of: id, failure: failure)

    var payload: [String: Any] = ["deviceId": id]
    if let reason { payload["error"] = reason.payload }
    central.log(reason == nil ? .debug : .info, "disconnected\(reason.map { ": \($0.code)" } ?? "")", deviceId: id)
    central.emit("disconnected", payload)
    central.emitConnection(id, "disconnected")
    for opId in disconnectOps { central.result(opId) }
    central.startQueuedConnects(self)
  }

  /// Bluetooth stopped: ends the connection, the attempt or the wait for a cancel to be confirmed, at once.
  func endForBluetoothOff(_ failure: BleError) {
    if isClosing {
      central.finishClose(self)
    } else if isReady {
      end(failure)
    } else {
      failAttempt(failure, cancelsPeripheral: false)
    }
  }

  /// Cancels the op timer and the L2CAP open timers, for the central's teardown.
  func cancelTimers() {
    opTimer?.cancel()
    opTimer = nil
    opTimerDue = nil
    for open in pendingL2capOpens { open.timer?.cancel() }
  }

  /// `error` under `code`, keeping CoreBluetooth's status.
  private func connectionFailure(_ error: Error?, _ code: String) -> BleError {
    guard let error else { return code == "disconnected" ? deviceDisconnected : BleError(code, "The connection failed") }
    let nsError = error as NSError
    return BleError(code, nsError.localizedDescription, nativeCode: nsError.code, nativeDomain: nsError.domain)
  }

  // MARK: Service discovery

  /// The connection is discovering services: on connect, or for a `rediscoverServices` op.
  private var isDiscovering: Bool {
    guard isAttached, !isClosing, !isHalted else { return false }
    if !isReady { return true }
    if let current, case .discover? = current.kind { return true }
    return false
  }

  /// Discovers every service, characteristic and descriptor; starting again forgets the callbacks still due.
  func startDiscovery() {
    discoveryRequests += 1
    pendingServices = []
    pendingCharacteristics = []
    forgetAttributes()
    peripheral.discoverServices(servicesToDiscover)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard isDiscovering else { return }
    discoveryRequests = max(discoveryRequests - 1, 0)
    // Discovery started again since; the answer to the latest request decides.
    guard discoveryRequests == 0 else { return }
    if let error { return discoveryFailed(error) }
    let services = peripheral.checkedServices
    pendingServices = Set(services.map { ObjectIdentifier($0) })
    pendingCharacteristics = []
    if services.isEmpty { return discoveryFinished() }
    for service in services { peripheral.discoverCharacteristics(nil, for: service) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard isDiscovering, discoveryRequests == 0, pendingServices.remove(ObjectIdentifier(service)) != nil else { return }
    if let error { central.log(.warn, "characteristic discovery of \(service.uuid.canonicalString): \(error.localizedDescription)", deviceId: id) }
    for characteristic in service.checkedCharacteristics {
      pendingCharacteristics.insert(ObjectIdentifier(characteristic))
      peripheral.discoverDescriptors(for: characteristic)
    }
    finishDiscoveryIfDone()
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverDescriptorsFor characteristic: CBCharacteristic, error: Error?) {
    guard isDiscovering, discoveryRequests == 0, pendingCharacteristics.remove(ObjectIdentifier(characteristic)) != nil else { return }
    finishDiscoveryIfDone()
  }

  private func finishDiscoveryIfDone() {
    if pendingServices.isEmpty, pendingCharacteristics.isEmpty { discoveryFinished() }
  }

  /// Discovery finished: the connection is ready, or the `rediscoverServices` op answers with the services.
  private func discoveryFinished() {
    guard isReady, let current else { return becomeReady() }
    finish(current, value: peripheral.servicesPayload)
  }

  private func discoveryFailed(_ error: Error) {
    guard isReady, let current else { return failAttempt(BleError(error, fallback: "connection-failed"), cancelsPeripheral: true) }
    finish(current, error: error)
  }

  /// A Service Changed indication: CoreBluetooth dropped `invalidatedServices`. A discovery under way starts
  /// again, so it answers with the new services instead of waiting for callbacks that may never come. Otherwise
  /// JS discovers them again with a `rediscoverServices` op, which queues behind the operations already asked for.
  func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    guard isAttached, !isClosing, !isHalted else { return }
    central.log(.info, "the device changed its services", deviceId: id)
    forgetAttributes()
    if isDiscovering { startDiscovery() }
    if isReady { central.emit("servicesChanged", ["deviceId": id]) }
  }

  /// Forgets what was found among the services, which are about to change.
  private func forgetAttributes() {
    notificationKeys = [:]
    characteristicCache = [:]
  }

  // MARK: GATT operations

  /// Compares `CBUUID`s, which match across their 16-, 32- and 128-bit forms.
  func characteristic(_ characteristic: String, inService service: String) throws(BleError) -> CBCharacteristic {
    let path = CharacteristicPath(service: service, characteristic: characteristic)
    if let cached = characteristicCache[path] { return cached }
    guard let uuid = CBUUID(validating: service), let found = peripheral.checkedServices.first(where: { $0.uuid == uuid }) else {
      throw BleError("not-found", "Service \(service) not found")
    }
    guard let uuid = CBUUID(validating: characteristic), let match = found.checkedCharacteristics.first(where: { $0.uuid == uuid }) else {
      throw BleError("not-found", "Characteristic \(characteristic) not found")
    }
    characteristicCache[path] = match
    return match
  }

  func descriptor(
    _ descriptor: String, ofCharacteristic characteristic: String, inService service: String
  ) throws(BleError) -> CBDescriptor {
    let owner = try self.characteristic(characteristic, inService: service)
    guard let uuid = CBUUID(validating: descriptor), let match = owner.checkedDescriptors.first(where: { $0.uuid == uuid }) else {
      throw BleError("not-found", "Descriptor \(descriptor) not found")
    }
    return match
  }

  /// Whether new operations may queue: the connection is up and not ending.
  var acceptsOperations: Bool { isReady && !isDisconnectRequested && !isHalted }

  func enqueue(_ op: GattOp) {
    queuedOps.append(op)
    pump()
  }

  /// Starts queued operations until one is running. Once the connection is ending nothing starts: what is queued
  /// fails when it has ended.
  private func pump() {
    // An op that settles while starting returns here instead of nesting another loop.
    guard !isPumping else { return }
    isPumping = true
    defer { isPumping = false }
    while current == nil, !isHalted, !isDisconnectRequested, !queuedOps.isEmpty {
      let op = queuedOps.removeFirst()
      if queuedOps.isEmpty { queuedOps = [] }
      do throws(BleError) {
        op.kind = try op.build(self)
      } catch {
        if !op.hasTimedOut, !op.isInternal { central.fail(op.opId, error) }
        continue
      }
      current = op
      start(op)
      // An op that settled while starting, such as a write without response, needs no timer.
      if current === op, op.timeout > 0 { armOpTimer(op) }
    }
  }

  private func armOpTimer(_ op: GattOp) {
    let deadline = DispatchTime.now() + op.timeout / 1000
    op.deadline = deadline
    if let due = opTimerDue, due <= deadline { return }
    scheduleOpTimer(deadline)
  }

  private func scheduleOpTimer(_ deadline: DispatchTime) {
    let timer = opTimer ?? makeOpTimer()
    opTimerDue = deadline
    timer.schedule(deadline: deadline)
  }

  private func makeOpTimer() -> DispatchSourceTimer {
    let timer = DispatchSource.makeTimerSource(queue: central.queue)
    timer.setEventHandler { [weak self] in
      guard let self, !self.central.isInvalidated else { return }
      self.opTimerDue = nil
      guard let current = self.current, let deadline = current.deadline else { return }
      if DispatchTime.now() >= deadline { self.timedOut(current) } else { self.scheduleOpTimer(deadline) }
    }
    timer.activate()
    opTimer = timer
    return timer
  }

  private func start(_ op: GattOp) {
    guard let kind = op.kind else { return }
    switch kind {
    case .read(let characteristic):
      peripheral.readValue(for: characteristic)
    case .write(let characteristic, let data, let withoutResponse):
      if !withoutResponse {
        peripheral.writeValue(data, for: characteristic, type: .withResponse)
      } else if op.hasTimedOut {
        // It timed out waiting for room, so JS was told it failed: it must not reach the device now.
        finish(op)
      } else if peripheral.canSendWriteWithoutResponse {
        peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
        finish(op)
      }
      // Otherwise `peripheralIsReady(toSendWriteWithoutResponse:)` starts it again.
    case .notify(let characteristic, let enable):
      if characteristic.isNotifying == enable { finish(op) } else { peripheral.setNotifyValue(enable, for: characteristic) }
    case .readDescriptor(let descriptor):
      peripheral.readValue(for: descriptor)
    case .writeDescriptor(let descriptor, let data):
      peripheral.writeValue(data, for: descriptor)
    case .readRssi:
      peripheral.readRSSI()
    case .discover:
      startDiscovery()
    }
  }

  /// The op fails with `timeout`, but keeps the queue until its callback arrives, so the late answer cannot settle
  /// the next op. Only an op still unanswered after a second timeout means the connection is stuck, and closes it.
  private func timedOut(_ op: GattOp) {
    guard current === op else { return }
    if op.hasTimedOut {
      central.log(.warn, "an operation is still unanswered after twice \(Int(op.timeout)) ms; disconnecting", deviceId: id)
      return drop(BleError("timeout", "An operation never answered, so the connection was closed"))
    }
    central.log(.warn, "an operation timed out after \(Int(op.timeout)) ms; waiting for its late answer", deviceId: id)
    op.hasTimedOut = true
    if !op.isInternal { central.fail(op.opId, BleError("timeout", "No answer within \(Int(op.timeout)) ms")) }
    armOpTimer(op)
  }

  /// Settles the running operation once and starts the next; it fails when CoreBluetooth reported `error`.
  private func finish(_ op: GattOp, value: Any? = nil, error: Error? = nil) {
    guard current === op else { return }
    current = nil
    if !op.hasTimedOut, !op.isInternal {
      if let error { central.fail(op.opId, BleError(error, fallback: "gatt")) } else { central.result(op.opId, with: value) }
    }
    // The MTU can change after connecting, and CoreBluetooth has no callback for it.
    if isReady { central.updateConnectionSnapshot(self) }
    pump()
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard isAttached else { return }
    // A pending read of this characteristic takes the value; JS hands it to subscribers too.
    if let op = current, case .read(let target)? = op.kind, target === characteristic {
      if !op.hasTimedOut {
        return finish(op, value: characteristic.value ?? Data(), error: error)
      }
      // JS gave up on the read; the value may be its late answer or a notification, so subscribers get it.
      finish(op)
    }
    guard error == nil, let value = characteristic.value, isReady, let key = notificationKey(characteristic) else { return }
    central.emitNotification(notificationDeviceId, key.service, key.uuid, value)
  }

  /// The service and characteristic UUIDs a notification from `characteristic` carries, made on its first one.
  private func notificationKey(_ characteristic: CBCharacteristic) -> (service: NSString, uuid: NSString)? {
    let identifier = ObjectIdentifier(characteristic)
    if let key = notificationKeys[identifier], key.characteristic === characteristic { return (key.service, key.uuid) }
    // `service` is weak and can be gone; find the owner among the cached services instead.
    let owner = characteristic.service ?? peripheral.checkedServices.first { service in
      service.checkedCharacteristics.contains { $0 === characteristic }
    }
    guard let owner else { return nil }
    let key = (characteristic: characteristic, service: owner.uuid.canonicalString as NSString, uuid: characteristic.uuid.canonicalString as NSString)
    notificationKeys[identifier] = key
    return (key.service, key.uuid)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    guard isAttached, let op = current, case .write(let target, _, false)? = op.kind, target === characteristic else { return }
    finish(op, error: error)
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    guard isAttached, let op = current, case .write(_, _, true)? = op.kind else { return }
    start(op)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard isAttached, let op = current, case .notify(let target, let enable)? = op.kind, target === characteristic else { return }
    if let error { return finish(op, error: error) }
    if op.hasTimedOut, enable, characteristic.isNotifying {
      // The subscribe timed out, so nobody listens: turn it off again, before anything queued meanwhile, such as
      // a retry. Nobody waits for this op either.
      let disable = GattOp(opId: op.opId, timeout: op.timeout) { _ in .notify(characteristic, enable: false) }
      disable.isInternal = true
      queuedOps.insert(disable, at: queuedOps.startIndex)
    }
    finish(op)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor descriptor: CBDescriptor, error: Error?) {
    guard isAttached, let op = current, case .readDescriptor(let target)? = op.kind, target === descriptor else { return }
    finish(op, value: bytesOfDescriptorValue(descriptor.value), error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor descriptor: CBDescriptor, error: Error?) {
    guard isAttached, let op = current, case .writeDescriptor(let target, _)? = op.kind, target === descriptor else { return }
    finish(op, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
    guard isAttached, let op = current, case .readRssi? = op.kind else { return }
    finish(op, value: RSSI.intValue, error: error)
  }

  // MARK: L2CAP

  func openL2capChannel(_ opId: Double, psm: CBL2CAPPSM, timeout: Double) {
    var timer: DispatchWorkItem?
    if timeout > 0 {
      timer = central.after(milliseconds: timeout) { [self] central in
        guard let index = pendingL2capOpens.firstIndex(where: { $0.opId == opId }) else { return }
        pendingL2capOpens.remove(at: index)
        central.fail(opId, BleError("timeout", "The channel did not open within \(Int(timeout)) ms"))
      }
    }
    pendingL2capOpens.append(PendingL2capOpen(opId: opId, psm: psm, timer: timer))
    peripheral.openL2CAPChannel(psm)
  }

  /// Matches the channel to the pending open of its PSM. A channel nobody waits for, say after its open timed
  /// out, is closed; a failure without a channel names no PSM, so it goes to the oldest open.
  func peripheral(_ peripheral: CBPeripheral, didOpen channel: CBL2CAPChannel?, error: Error?) {
    let index: Int? =
      if !isAttached {
        nil
      } else if let channel {
        pendingL2capOpens.firstIndex { $0.psm == channel.psm }
      } else {
        pendingL2capOpens.indices.first
      }
    guard let index else {
      if let channel { closeUnclaimed(channel) }
      return
    }
    let open = pendingL2capOpens.remove(at: index)
    open.timer?.cancel()
    if let error {
      if let channel { closeUnclaimed(channel) }
      return central.fail(open.opId, BleError(error, fallback: "connection-failed"))
    }
    guard let channel else { return central.fail(open.opId, BleError("connection-failed", "The channel did not open")) }
    guard let id = central.addChannel(channel, deviceId: id) else {
      closeUnclaimed(channel)
      return central.fail(open.opId, BleError("connection-failed", "The channel opened without streams"))
    }
    central.result(open.opId, with: ["channelId": id])
  }

  /// CoreBluetooth closes a channel once its streams are closed.
  private func closeUnclaimed(_ channel: CBL2CAPChannel) {
    channel.inputStream?.close()
    channel.outputStream?.close()
  }
}
