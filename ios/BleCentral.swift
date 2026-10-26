import CoreBluetooth
import Foundation
import UIKit

/// What the central reports to: event delivery to JS and the store of bytes JS handed over.
@objc public protocol BleCentralDelegate: AnyObject {
  func emit(_ type: String, payload: [String: Any])
  /// Emits an op's `result` event without building an envelope dictionary; it stays in order with other events.
  func emitResult(_ opId: Double, value: Any?, error: [String: Any]?)
  /// Emits a notification without building a dictionary: after advertisements, the busiest event path. The strings
  /// are Objective-C ones the connection made once, so nothing is converted per notification, and the bytes are
  /// copied once, straight into the event.
  func emitNotification(_ deviceId: NSString, service: NSString, characteristic: NSString, bytes: UnsafeRawPointer?, count: Int)
  /// Emits L2CAP data without building a dictionary, copying the bytes once, straight into the event.
  func emitL2capData(_ channelId: Int, bytes: UnsafeRawPointer?, count: Int)
  func takeBytes(_ handle: Double) -> Data?
}

/// Creating the manager without this key in Info.plist makes iOS kill the app.
private let missingUsageDescription = BleError(
  "unauthorized", "NSBluetoothAlwaysUsageDescription is missing from Info.plist; add the config plugin or the key"
)
private let valueNotFound = BleError("invalid-argument", "The value was not found")

/// What all devices share: the one CoreBluetooth manager and its queue, permission and Bluetooth state, scanning,
/// the peripherals seen, the connections, the open L2CAP channels and state restoration. Work for one device goes
/// to its `Connection`. Every method body, delegate callback and timer runs on `queue`, so its state needs no locks.
/// Public methods are called on the JS thread and enqueue their work, except the synchronous getters, which read
/// snapshots under `snapshotLock`, `invalidate`, which waits for the queue, and `deviceId(forDiscovered:)` and the
/// `CBCentralManagerDelegate` methods, which the manager's delegate calls on `queue`.
@objc(BleCentral)
public final class BleCentral: NSObject {
  let queue = DispatchQueue(label: "com.wekor.reactnativeble")
  private weak var delegate: BleCentralDelegate?

  private(set) var manager: CBCentralManager?
  private(set) var isInvalidated = false
  private var logLevel = LogLevel.warn
  private var showsPowerAlert = false
  private var restoreIdentifier: String?
  private var reportedState: String?
  /// Work that needs Bluetooth, waiting for the manager's first known state.
  private var whenKnown: [() -> Void] = []
  private var permissionOps: [Double] = []
  private var wasPoweredOn = false

  /// Peripherals seen in scans or retrieved, by id, so `connect()` can find them again.
  private var peripheralCache = PeripheralCache()
  private var connections: [String: Connection] = [:]
  /// Every connect call not answered yet, wherever it waits, so `invalidate` can cancel their timers.
  private var pendingConnects: [Double: ConnectOp] = [:]

  /// The scan JS asked for, and the one running.
  private var requestedScan: ScanConfig?
  private var runningScan: ScanConfig?

  /// What `willRestoreState` handed over, until Bluetooth is on and it can be reported.
  private var restoredState: [String: Any]?
  private var restoreConnected: [[String: Any]] = []
  private var restoreConnecting: [[String: Any]] = []
  private var restorePending = 0
  private var restoreScan: [String]?

  /// Open L2CAP channels by the id JS knows them by.
  private var l2capChannels: [Int: L2capChannel] = [:]
  private var nextChannelId = 1

  /// What the synchronous getters return. Written on `queue` whenever the mirrored state changes and read on the
  /// JS thread under the lock, so a getter never waits behind Bluetooth work.
  private let snapshotLock = NSLock()
  /// Before there is a manager, derived from the permission.
  private var stateSnapshot = "unknown"
  private var connectionSnapshots: [String: ConnectionSnapshot] = [:]

  /// Each read of `CBManager.authorization` is an XPC call to tccd, about half a millisecond. It changes only when
  /// the user answers the prompt, which also updates the manager's state, or in Settings, after which the app
  /// becomes active. Guarded by `snapshotLock`, so any thread can read it.
  private var cachedAuthorization: CBManagerAuthorization?
  private var activeObserver: NSObjectProtocol?

  /// The manager's delegate, supplied by the module: it turns advertisements into C++ values itself and forwards
  /// every other event to this object.
  private let managerDelegate: CBCentralManagerDelegate

  @objc public init(delegate: BleCentralDelegate, managerDelegate: CBCentralManagerDelegate) {
    self.delegate = delegate
    self.managerDelegate = managerDelegate
    super.init()
    // Read here once, so `getState` never asks the system.
    updateStateSnapshot()
    activeObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        guard let self, !self.isInvalidated else { return }
        self.forgetAuthorization()
        self.updateStateSnapshot()
      }
    }
  }

  // MARK: Reporting

  func emit(_ type: String, _ payload: [String: Any]) {
    guard !isInvalidated else { return }
    delegate?.emit(type, payload: payload)
  }

  func emitConnection(_ deviceId: String, _ state: String) {
    emit("connection", ["deviceId": deviceId, "state": state])
  }

  func emitNotification(_ deviceId: NSString, _ service: NSString, _ characteristic: NSString, _ value: Data) {
    guard !isInvalidated else { return }
    value.withUnsafeBytes {
      delegate?.emitNotification(deviceId, service: service, characteristic: characteristic, bytes: $0.baseAddress, count: $0.count)
    }
  }

  func emitL2capData(_ channelId: Int, _ bytes: UnsafeRawBufferPointer) {
    guard !isInvalidated else { return }
    delegate?.emitL2capData(channelId, bytes: bytes.baseAddress, count: bytes.count)
  }

  func result(_ opId: Double, with value: Any? = nil) {
    guard !isInvalidated else { return }
    delegate?.emitResult(opId, value: value, error: nil)
  }

  func fail(_ opId: Double, _ failure: BleError) {
    log(.debug, "op \(Int(opId)) failed: \(failure.code) \(failure.message)")
    guard !isInvalidated else { return }
    delegate?.emitResult(opId, value: nil, error: failure.payload)
  }

  /// `message` is built only when `level` is logged.
  func log(_ level: LogLevel, _ message: @autoclosure () -> String, deviceId: String? = nil) {
    guard level >= logLevel else { return }
    var payload: [String: Any] = ["level": level.name, "message": message()]
    if let deviceId { payload["deviceId"] = deviceId }
    emit("log", payload)
  }

  /// Runs `body` on the queue after `milliseconds` unless cancelled first. A cancelled item stays queued until its
  /// deadline, so it holds the central weakly: a pending timer must not keep an invalidated central and its manager
  /// alive.
  func after(milliseconds: Double, execute body: @escaping (BleCentral) -> Void) -> DispatchWorkItem {
    let item = DispatchWorkItem { [weak self] in
      guard let self, !self.isInvalidated else { return }
      body(self)
    }
    queue.asyncAfter(deadline: .now() + milliseconds / 1000, execute: item)
    return item
  }

  private func takeBytes(_ handle: Double) -> Data? { delegate?.takeBytes(handle) }

  // MARK: Snapshots

  private func withSnapshots<T>(_ body: () -> T) -> T {
    snapshotLock.lock()
    defer { snapshotLock.unlock() }
    return body()
  }

  /// Updates the state snapshot; without a manager it is derived from the permission.
  private func updateStateSnapshot() {
    let state =
      if manager != nil {
        stateName
      } else if authorization == .allowedAlways {
        CBManagerState.unknown.name
      } else {
        CBManagerState.unauthorized.name
      }
    withSnapshots { stateSnapshot = state }
  }

  /// Updates the snapshot of an established connection; cheap when nothing changed.
  func updateConnectionSnapshot(_ connection: Connection) {
    let snapshot = ConnectionSnapshot(
      maxWriteWithoutResponse: connection.peripheral.maximumWriteValueLength(for: .withoutResponse),
      ancsAuthorized: connection.peripheral.ancsAuthorized
    )
    guard snapshot != connection.snapshot else { return }
    connection.snapshot = snapshot
    withSnapshots { connectionSnapshots[connection.id] = snapshot }
  }

  // MARK: Bluetooth

  /// Cached; safe to read from any thread.
  private var authorization: CBManagerAuthorization {
    if let cached = withSnapshots({ cachedAuthorization }) { return cached }
    let value = CBManager.authorization
    withSnapshots { cachedAuthorization = value }
    return value
  }

  private func forgetAuthorization() {
    withSnapshots { cachedAuthorization = nil }
  }

  /// Expo's `PermissionResponse`: iOS prompts only while the user has not answered.
  private var permission: [String: Any] {
    let authorization = authorization
    let status: String
    switch authorization {
    case .allowedAlways: status = "granted"
    case .notDetermined: status = "undetermined"
    default: status = "denied"
    }
    return ["status": status, "canAskAgain": authorization == .notDetermined]
  }

  /// Creates the manager on first need. Creating it is what shows the permission prompt, and without the usage
  /// description in Info.plist iOS kills the app instead, so check that first.
  @discardableResult
  private func ensureManager() -> Bool {
    if manager != nil { return true }
    guard Bundle.main.object(forInfoDictionaryKey: "NSBluetoothAlwaysUsageDescription") != nil else {
      log(.error, missingUsageDescription.message)
      withSnapshots { stateSnapshot = CBManagerState.unauthorized.name }
      return false
    }
    var options: [String: Any] = [CBCentralManagerOptionShowPowerAlertKey: showsPowerAlert]
    if let restoreIdentifier { options[CBCentralManagerOptionRestoreIdentifierKey] = restoreIdentifier }
    manager = CBCentralManager(delegate: managerDelegate, queue: queue, options: options)
    updateStateSnapshot()
    return true
  }

  private var stateName: String {
    guard authorization == .allowedAlways, let manager else { return CBManagerState.unauthorized.name }
    return manager.state.name
  }

  /// Runs `action` once Bluetooth is on, or reports why it cannot.
  private func whenPoweredOn(_ action: @escaping (CBCentralManager) -> Void, otherwise: @escaping (BleError) -> Void) {
    guard authorization == .allowedAlways else {
      return otherwise(BleError(unavailableIn: .unauthorized))
    }
    guard ensureManager(), let manager else { return otherwise(missingUsageDescription) }
    let run = {
      if manager.state == .poweredOn { action(manager) } else { otherwise(BleError(unavailableIn: manager.state)) }
    }
    if manager.state == .unknown || manager.state == .resetting { whenKnown.append(run) } else { run() }
  }

  @objc public func configure(_ options: [String: Any]) {
    queue.async { [self] in
      if let name = options["logLevel"] as? String, let level = LogLevel(name: name) { logLevel = level }
      guard let ios = options["ios"] as? [String: Any] else { return }
      let alert = ios["showPowerAlert"] as? Bool ?? showsPowerAlert
      let identifier = ios["restoreIdentifier"] as? String ?? restoreIdentifier
      if manager != nil {
        if alert != showsPowerAlert || identifier != restoreIdentifier {
          log(.warn, "configure({ ios }) is read when the Bluetooth manager is created; it already exists")
        }
        return
      }
      showsPowerAlert = alert
      restoreIdentifier = identifier
      // iOS hands restored connections to the manager created with this identifier, so create it now.
      if restoreIdentifier != nil, authorization == .allowedAlways { ensureManager() }
    }
  }

  @objc public func getState() -> String {
    let state = withSnapshots { stateSnapshot }
    // Permitted but not known yet: create the manager, if there is none, so that `state` events start.
    if state == CBManagerState.unknown.name {
      queue.async { [self] in
        if !isInvalidated { ensureManager() }
      }
    }
    return state
  }

  @objc public func getPermission(_ opId: Double) {
    queue.async { [self] in result(opId, with: permission) }
  }

  @objc public func requestPermission(_ opId: Double) {
    queue.async { [self] in
      guard authorization == .notDetermined else { return result(opId, with: permission) }
      guard ensureManager() else { return fail(opId, missingUsageDescription) }
      permissionOps.append(opId)
    }
  }

  // MARK: Scan

  @objc public func setScan(_ config: [String: Any]?) {
    let config = config.map(ScanConfig.init)
    queue.async { [self] in
      guard let config else {
        requestedScan = nil
        stopNativeScan()
        return
      }
      requestedScan = config
      whenPoweredOn({ [self] _ in applyScan() }, otherwise: { [self] failure in
        guard requestedScan != nil else { return }
        requestedScan = nil
        emit("scanError", ["error": failure.payload])
      })
    }
  }

  private func applyScan() {
    guard let config = requestedScan, let manager, manager.state == .poweredOn else { return }
    if manager.isScanning, runningScan == config { return }
    var options: [String: Any] = [CBCentralManagerScanOptionAllowDuplicatesKey: config.allowsDuplicates]
    if !config.solicitedServices.isEmpty { options[CBCentralManagerScanOptionSolicitedServiceUUIDsKey] = config.solicitedServices }
    log(.debug, "scan \(config.services?.map(\.canonicalString) ?? ["all"])")
    // Stopped first, so the scan is a new session: CoreBluetooth reports each device once per session, and a scan
    // that joined (the config's `reportGeneration` changed) must hear the devices reported before it.
    if manager.isScanning { manager.stopScan() }
    manager.scanForPeripherals(withServices: config.services, options: options)
    runningScan = config
  }

  private func stopNativeScan() {
    runningScan = nil
    // stopScan while not powered on is API misuse.
    if let manager, manager.state == .poweredOn, manager.isScanning { manager.stopScan() }
  }

  /// The id to report an advertisement from `peripheral` under, or nil when no scan wants it. The manager's
  /// delegate calls this from `didDiscover` and builds the advertisement itself.
  @objc public func deviceId(forDiscovered peripheral: CBPeripheral) -> String? {
    guard !isInvalidated, requestedScan != nil else { return nil }
    let id = peripheral.identifier.uuidString
    peripheralCache.insert(peripheral, for: id)
    return id
  }

  // MARK: Connections

  @objc public func connect(_ opId: Double, deviceId: String, options: [String: Any]) {
    let options = ConnectOptions(options)
    queue.async { [self] in
      guard let timeout = options.timeout else {
        return fail(opId, BleError("invalid-argument", "connect() needs a timeout"))
      }
      let op = ConnectOp(opId: opId, options: options)
      pendingConnects[opId] = op
      // One timer for the whole wait: for Bluetooth's state, behind a connection still ending, and for the connection itself.
      if timeout > 0 {
        op.timer = after(milliseconds: timeout) { $0.connectTimedOut(op, deviceId, timeout) }
      }
      whenPoweredOn({ [self] manager in startConnect([op], to: deviceId, using: manager) }, otherwise: { [self] in settle(op, failure: $0) })
    }
  }

  /// Answers a connect call exactly once, however many paths reach it.
  func settle(_ op: ConnectOp, with value: Any? = nil, failure: BleError? = nil) {
    guard !op.isAnswered else { return }
    op.isAnswered = true
    op.timer?.cancel()
    pendingConnects[op.opId] = nil
    if let failure { fail(op.opId, failure) } else { result(op.opId, with: value) }
  }

  /// A connect call's timeout. It fails alone; the attempt it waited on is cancelled once nobody waits for it.
  private func connectTimedOut(_ op: ConnectOp, _ deviceId: String, _ timeout: Double) {
    guard !op.isAnswered else { return }
    let failure = BleError("timeout", "No connection within \(Int(timeout)) ms")
    guard let connection = connections[deviceId] else { return settle(op, failure: failure) }
    let waited = connection.connectOps.contains { $0 === op }
    connection.connectOps.removeAll { $0 === op }
    connection.reconnectOps.removeAll { $0 === op }
    settle(op, failure: failure)
    // A connection restored already connected belongs to the app; it stays up without a caller.
    if waited, connection.connectOps.isEmpty, !connection.isRestoring {
      connection.failAttempt(failure, cancelsPeripheral: true)
    }
  }

  private func peripheral(for deviceId: String, in manager: CBCentralManager) -> CBPeripheral? {
    if let peripheral = peripheralCache.peripheral(for: deviceId) { return peripheral }
    guard let uuid = UUID(uuidString: deviceId), let peripheral = manager.retrievePeripherals(withIdentifiers: [uuid]).first else {
      return nil
    }
    peripheralCache.insert(peripheral, for: deviceId)
    return peripheral
  }

  /// Starts or joins the connection for `ops`; the first one's options configure a new attempt.
  private func startConnect(_ ops: [ConnectOp], to deviceId: String, using manager: CBCentralManager) {
    // Some may have timed out while they waited.
    let ops = ops.filter { !$0.isAnswered }
    guard let first = ops.first else { return }
    if let connection = connections[deviceId] { return connection.join(ops) }
    guard let peripheral = peripheral(for: deviceId, in: manager) else {
      let failure = BleError("not-found", "The system does not know this device; scan for it again")
      for op in ops { settle(op, failure: failure) }
      return
    }

    let connection = Connection(id: deviceId, peripheral: peripheral, central: self)
    connection.connectOps = ops
    connection.servicesToDiscover = first.options.services
    connections[deviceId] = connection

    log(.debug, "connect", deviceId: deviceId)
    emitConnection(deviceId, "connecting")
    manager.connect(peripheral, options: first.options.peripheralOptions)
  }

  /// Takes `connection` out of the connections: its snapshot goes, and callbacks still due to it are ignored.
  func remove(_ connection: Connection) {
    guard connections[connection.id] === connection else { return }
    connections[connection.id] = nil
    connection.detach()
    connection.snapshot = nil
    withSnapshots { connectionSnapshots[connection.id] = nil }
  }

  /// A connection that never became ready has ended: the device is free for the connect calls waiting on it.
  func finishClose(_ connection: Connection) {
    guard connections[connection.id] === connection else { return }
    remove(connection)
    startQueuedConnects(connection)
  }

  /// Starts the connect calls that waited for `connection` to end, or fails them when Bluetooth is not on.
  func startQueuedConnects(_ connection: Connection) {
    let ops = connection.reconnectOps
    connection.reconnectOps = []
    guard !ops.isEmpty else { return }
    if let manager, manager.state == .poweredOn { return startConnect(ops, to: connection.id, using: manager) }
    let failure = BleError(unavailableIn: manager?.state ?? .unknown)
    for op in ops { settle(op, failure: failure) }
  }

  @objc public func disconnect(_ opId: Double, deviceId: String) {
    queue.async { [self] in
      guard let connection = connections[deviceId] else { return result(opId) }
      connection.disconnect(opId)
    }
  }

  @objc public func getConnectedDevices(_ opId: Double, services: [String]) {
    queue.async { [self] in
      whenPoweredOn({ [self] manager in
        let uuids = services.compactMap(CBUUID.init(validating:))
        guard !uuids.isEmpty else { return result(opId, with: [Any]()) }
        let devices = manager.retrieveConnectedPeripherals(withServices: uuids).map { peripheral in
          peripheralCache.insert(peripheral, for: peripheral.identifier.uuidString)
          return peripheral.payload
        }
        result(opId, with: devices)
      }, otherwise: { [self] in fail(opId, $0) })
    }
  }

  // MARK: GATT operations

  /// The device's connection when it takes new operations; otherwise fails `opId`.
  private func connection(for deviceId: String, failing opId: Double) -> Connection? {
    guard let connection = connections[deviceId], connection.acceptsOperations else {
      fail(opId, BleError("not-connected", "The device is not connected"))
      return nil
    }
    return connection
  }

  /// Queues an operation on the device's connection; `build` finds its attribute when it starts.
  private func enqueue(
    _ opId: Double, _ deviceId: String, _ timeout: Double, _ build: @escaping (Connection) throws(BleError) -> GattOp.Kind
  ) {
    queue.async { [self] in
      guard let connection = self.connection(for: deviceId, failing: opId) else { return }
      connection.enqueue(GattOp(opId: opId, timeout: timeout, build: build))
    }
  }

  @objc public func read(_ opId: Double, deviceId: String, service: String, characteristic: String, timeout: Double) {
    enqueue(opId, deviceId, timeout) { connection throws(BleError) in
      let target = try connection.characteristic(characteristic, inService: service)
      guard target.properties.contains(.read) else { throw BleError("not-permitted", "The characteristic cannot be read") }
      return .read(target)
    }
  }

  @objc public func write(
    _ opId: Double, deviceId: String, service: String, characteristic: String, valueHandle: Double, withoutResponse: Bool, timeout: Double
  ) {
    let data = takeBytes(valueHandle)
    enqueue(opId, deviceId, timeout) { connection throws(BleError) in
      guard let data else { throw valueNotFound }
      let target = try connection.characteristic(characteristic, inService: service)
      let maxLength = withoutResponse ? connection.peripheral.maximumWriteValueLength(for: .withoutResponse) : maxAttributeValueLength
      guard data.count <= maxLength else { throw BleError("invalid-argument", "The value is \(data.count) bytes; at most \(maxLength) fit") }
      let property: CBCharacteristicProperties = withoutResponse ? .writeWithoutResponse : .write
      guard target.properties.contains(property) else {
        throw BleError("not-permitted", withoutResponse ? "The characteristic cannot be written without response" : "The characteristic cannot be written")
      }
      return .write(target, data, withoutResponse: withoutResponse)
    }
  }

  @objc public func setNotify(
    _ opId: Double, deviceId: String, service: String, characteristic: String, enable: Bool, timeout: Double
  ) {
    // iOS picks notifications or indications itself.
    enqueue(opId, deviceId, timeout) { connection throws(BleError) in
      let target = try connection.characteristic(characteristic, inService: service)
      guard !enable || !target.properties.isDisjoint(with: [.notify, .indicate]) else {
        throw BleError("not-permitted", "The characteristic has neither notify nor indicate")
      }
      return .notify(target, enable: enable)
    }
  }

  @objc public func readDescriptor(
    _ opId: Double, deviceId: String, service: String, characteristic: String, descriptor: String, timeout: Double
  ) {
    enqueue(opId, deviceId, timeout) { connection throws(BleError) in
      .readDescriptor(try connection.descriptor(descriptor, ofCharacteristic: characteristic, inService: service))
    }
  }

  @objc public func writeDescriptor(
    _ opId: Double, deviceId: String, service: String, characteristic: String, descriptor: String, valueHandle: Double, timeout: Double
  ) {
    let data = takeBytes(valueHandle)
    enqueue(opId, deviceId, timeout) { connection throws(BleError) in
      guard let data else { throw valueNotFound }
      let target = try connection.descriptor(descriptor, ofCharacteristic: characteristic, inService: service)
      if target.uuid == CBUUID(string: CBUUIDClientCharacteristicConfigurationString) {
        throw BleError("not-permitted", "Use subscribe() instead of writing the Client Characteristic Configuration descriptor")
      }
      return .writeDescriptor(target, data)
    }
  }

  @objc public func readRssi(_ opId: Double, deviceId: String, timeout: Double) {
    enqueue(opId, deviceId, timeout) { _ in .readRssi }
  }

  @objc public func rediscoverServices(_ opId: Double, deviceId: String, timeout: Double) {
    enqueue(opId, deviceId, timeout) { _ in .discover }
  }

  @objc public func maxWriteLength(_ deviceId: String, withoutResponse: Bool) -> Double {
    guard let snapshot = withSnapshots({ connectionSnapshots[deviceId] }) else { return 0 }
    return Double(withoutResponse ? snapshot.maxWriteWithoutResponse : maxAttributeValueLength)
  }

  /// Only a connected device can have ANCS authorized.
  @objc public func getAncsAuthorized(_ deviceId: String) -> Bool {
    withSnapshots { connectionSnapshots[deviceId]?.ancsAuthorized ?? false }
  }

  /// Fails a call that exists only on Android.
  @objc public func unsupported(_ opId: Double) {
    queue.async { [self] in fail(opId, BleError("unsupported", "Not available on iOS")) }
  }

  // MARK: L2CAP channels

  @objc public func openL2capChannel(_ opId: Double, deviceId: String, psm: Double, timeout: Double) {
    queue.async { [self] in
      guard let connection = self.connection(for: deviceId, failing: opId) else { return }
      connection.openL2capChannel(opId, psm: CBL2CAPPSM(psm), timeout: timeout)
    }
  }

  @objc public func writeL2capChannel(_ opId: Double, channelId: Double, valueHandle: Double) {
    let data = takeBytes(valueHandle)
    queue.async { [self] in
      guard let channel = l2capChannels[Int(channelId)] else { return fail(opId, BleError("not-connected", "The channel is closed")) }
      guard let data else { return fail(opId, valueNotFound) }
      channel.write(opId, data)
    }
  }

  @objc public func closeL2capChannel(_ opId: Double, channelId: Double) {
    queue.async { [self] in
      if let channel = l2capChannels[Int(channelId)] { close(channel) }
      result(opId)
    }
  }

  /// Opens a channel that just connected under the next id; nil when it came without its streams.
  func addChannel(_ cbChannel: CBL2CAPChannel, deviceId: String) -> Int? {
    let id = nextChannelId
    guard let channel = L2capChannel(id: id, deviceId: deviceId, channel: cbChannel, central: self) else { return nil }
    nextChannelId += 1
    l2capChannels[id] = channel
    channel.open(on: queue)
    return id
  }

  func close(_ channel: L2capChannel, failure: BleError? = nil) {
    guard l2capChannels[channel.id] === channel else { return }
    l2capChannels[channel.id] = nil
    let pending = channel.close()
    for opId in pending { fail(opId, failure ?? BleError("disconnected", "The channel closed")) }
    var payload: [String: Any] = ["channelId": channel.id]
    if let failure { payload["error"] = failure.payload }
    emit("l2capClosed", payload)
  }

  /// Closes every channel of the device, as its connection ends.
  func closeChannels(of deviceId: String, failure: BleError) {
    for channel in l2capChannels.values where channel.deviceId == deviceId { close(channel, failure: failure) }
  }

  // MARK: Restoration

  private func startRestore(_ central: CBCentralManager) {
    guard let state = restoredState else { return }
    restoredState = nil
    if let services = state[CBCentralManagerRestoredStateScanServicesKey] as? [CBUUID] {
      restoreScan = services.map(\.canonicalString)
    }
    // The library stopped the restored scan; JS starts a new one if it wants to keep scanning.
    if state[CBCentralManagerRestoredStateScanServicesKey] != nil || state[CBCentralManagerRestoredStateScanOptionsKey] != nil {
      if central.isScanning { central.stopScan() }
    }
    let peripherals = (state[CBCentralManagerRestoredStatePeripheralsKey] as? NSArray).map {
      elements($0, of: CBPeripheral.self)
    } ?? []
    for peripheral in peripherals {
      let id = peripheral.identifier.uuidString
      peripheralCache.insert(peripheral, for: id)
      guard connections[id] == nil, peripheral.state == .connected || peripheral.state == .connecting else { continue }
      let connection = Connection(id: id, peripheral: peripheral, central: self)
      connections[id] = connection
      if peripheral.state == .connecting {
        // A pending connect iOS kept for the app: it stays pending without a timer. JS reports it, a `connect()`
        // joins it, and `didConnectPeripheral` discovers every service.
        restoreConnecting.append(peripheral.payload)
        emitConnection(id, "connecting")
        continue
      }
      connection.isRestoring = true
      connection.hasConnected = true
      restorePending += 1
      connection.startDiscovery()
    }
    if restorePending == 0 { emitRestore() }
  }

  /// A restored connection finished its discovery, or failed to.
  func finishRestore(_ connection: Connection, connected: Bool) {
    connection.isRestoring = false
    if connected {
      restoreConnected.append(connection.readyPayload.merging(connection.peripheral.payload) { $1 })
      emitConnection(connection.id, "connected")
    }
    restorePending -= 1
    if restorePending == 0 { emitRestore() }
  }

  private func emitRestore() {
    var payload: [String: Any] = ["connected": restoreConnected, "connecting": restoreConnecting]
    if let restoreScan { payload["scan"] = ["services": restoreScan] }
    restoreConnected = []
    restoreConnecting = []
    restoreScan = nil
    emit("restore", payload)
  }

  // MARK: Lifecycle

  @objc public func invalidate() {
    if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
    queue.sync {
      isInvalidated = true
      // Cancelled timers are dropped unrun; they hold the central weakly until their deadline.
      for op in pendingConnects.values { op.timer?.cancel() }
      pendingConnects = [:]
      for connection in connections.values {
        connection.cancelTimers()
        connection.detach()
      }
      if let manager {
        if manager.state == .poweredOn {
          if manager.isScanning { manager.stopScan() }
          for connection in connections.values { manager.cancelPeripheralConnection(connection.peripheral) }
        }
        manager.delegate = nil
      }
      // Let go of the manager: a reloaded module creates another, and only one should hold the restore identifier.
      manager = nil
      for channel in l2capChannels.values { _ = channel.close() }
      l2capChannels = [:]
      connections = [:]
      whenKnown = []
      permissionOps = []
      withSnapshots { connectionSnapshots = [:] }
    }
  }
}

extension BleCentral: CBCentralManagerDelegate {
  public func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard !isInvalidated else { return }
    let poweredOn = central.state == .poweredOn
    forgetAuthorization()

    // Leaving powered-on ends whatever is left at once: CoreBluetooth does not always send disconnect callbacks for it.
    if wasPoweredOn, !poweredOn { endConnectionsAndScan(BleError(unavailableIn: central.state)) }
    wasPoweredOn = poweredOn

    if poweredOn, restoredState != nil { startRestore(central) }

    updateStateSnapshot()
    let name = stateName
    if name != reportedState {
      reportedState = name
      emit("state", ["state": name])
    }

    // After the state, so JS has it when the request settles.
    if authorization != .notDetermined, !permissionOps.isEmpty {
      let opIds = permissionOps
      permissionOps = []
      for opId in opIds { result(opId, with: permission) }
    }

    if central.state != .unknown, central.state != .resetting {
      let waiting = whenKnown
      whenKnown = []
      for action in waiting { action() }
    }
    if !poweredOn, restoredState != nil, central.state != .unknown, central.state != .resetting {
      // iOS keeps neither connections nor scans across Bluetooth turning off, so the restore reports nothing.
      restoredState = nil
      emitRestore()
    }
  }

  private func endConnectionsAndScan(_ failure: BleError) {
    for connection in Array(connections.values) { connection.endForBluetoothOff(failure) }
    if requestedScan != nil || runningScan != nil {
      requestedScan = nil
      runningScan = nil
      emit("scanError", ["error": failure.payload])
    }
  }

  public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connections[peripheral.identifier.uuidString]?.didConnectPeripheral()
  }

  public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connections[peripheral.identifier.uuidString]?.didFailToConnect(error)
  }

  public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    connections[peripheral.identifier.uuidString]?.didDisconnectPeripheral(error)
  }

  public func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    // Fires before the first state update; held until Bluetooth is on.
    restoredState = dict
  }

  public func centralManager(_ central: CBCentralManager, didUpdateANCSAuthorizationFor peripheral: CBPeripheral) {
    guard let connection = connections[peripheral.identifier.uuidString], connection.isReady else { return }
    updateConnectionSnapshot(connection)
  }
}

/// Peripherals by id, bounded: a scan can see a new random address every few seconds for hours. Two generations
/// keep the recently used ones: inserts go to `current`, and when it fills, it becomes `previous`, dropping the
/// older generation. CoreBluetooth still finds a dropped peripheral by id through `retrievePeripherals`.
struct PeripheralCache {
  private static let generationSize = 512
  private var current: [String: CBPeripheral] = [:]
  private var previous: [String: CBPeripheral] = [:]

  mutating func insert(_ peripheral: CBPeripheral, for id: String) {
    current[id] = peripheral
    if current.count >= Self.generationSize {
      previous = current
      current = [:]
    }
  }

  mutating func peripheral(for id: String) -> CBPeripheral? {
    if let peripheral = current[id] { return peripheral }
    guard let peripheral = previous[id] else { return nil }
    insert(peripheral, for: id)
    return peripheral
  }
}

/// The native scan JS asks for, read once from its config.
struct ScanConfig: Equatable {
  /// Nil scans for every device.
  let services: [CBUUID]?
  let solicitedServices: [CBUUID]
  let allowsDuplicates: Bool
  /// Changes when a scan joins, so an otherwise equal config still restarts the scan.
  let reportGeneration: Double

  init(_ config: [String: Any]) {
    let ios = config["ios"] as? [String: Any]
    services = (config["services"] as? [String])?.compactMap(CBUUID.init(validating:))
    solicitedServices = (ios?["solicitedServices"] as? [String])?.compactMap(CBUUID.init(validating:)) ?? []
    allowsDuplicates = config["allowDuplicates"] as? Bool ?? false
    reportGeneration = ios?["reportGeneration"] as? Double ?? 0
  }
}
