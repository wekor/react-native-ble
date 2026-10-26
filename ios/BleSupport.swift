import CoreBluetooth
import Foundation

extension CBUUID {
  /// The UUID as JS receives it: lowercase and 128-bit, where CoreBluetooth prints the short forms of SIG UUIDs.
  var canonicalString: String {
    let raw = uuidString.lowercased()
    switch raw.utf8.count {
    case 4: return "0000\(raw)-0000-1000-8000-00805f9b34fb"
    case 8: return "\(raw)-0000-1000-8000-00805f9b34fb"
    default: return raw
    }
  }

  /// Nil unless `string` is a 16-, 32- or 128-bit UUID: `CBUUID(string:)` raises on anything else.
  convenience init?(validating string: String) {
    guard Self.isWellFormed(string) else { return nil }
    self.init(string: string)
  }

  /// 4 or 8 hex digits, or 32 with dashes in the 8-4-4-4-12 places; ASCII only.
  private static func isWellFormed(_ string: String) -> Bool {
    let utf8 = string.utf8
    let count = utf8.count
    guard count == 4 || count == 8 || count == 36 else { return false }
    for (index, byte) in utf8.enumerated() {
      if count == 36, index == 8 || index == 13 || index == 18 || index == 23 {
        guard byte == UInt8(ascii: "-") else { return false }
        continue
      }
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "a")...UInt8(ascii: "f"), UInt8(ascii: "A")...UInt8(ascii: "F"):
        continue
      default:
        return false
      }
    }
    return true
  }
}

/// A `BleError` as JS receives it.
struct BleError: Error {
  let code: String
  let message: String
  let nativeCode: Int?
  let nativeDomain: String?

  init(_ code: String, _ message: String, nativeCode: Int? = nil, nativeDomain: String? = nil) {
    self.code = code
    self.message = message
    self.nativeCode = nativeCode
    self.nativeDomain = nativeDomain
  }

  /// `fallback` names what failed, for errors CoreBluetooth reports without a more specific meaning.
  init(_ error: Error, fallback: String = "unknown") {
    let nsError = error as NSError
    var code = fallback
    if nsError.domain == CBATTErrorDomain {
      code = "gatt"
    } else if nsError.domain == CBErrorDomain {
      switch CBError.Code(rawValue: nsError.code) {
      case .connectionTimeout: code = "timeout"
      case .peripheralDisconnected: code = "disconnected"
      case .notConnected: code = "not-connected"
      case .connectionFailed: code = "connection-failed"
      case .unknownDevice: code = "not-found"
      case .operationCancelled: code = "cancelled"
      case .invalidParameters: code = "invalid-argument"
      case .encryptionTimedOut, .peerRemovedPairingInformation: code = "gatt"
      default: break
      }
    }
    self.init(code, nsError.localizedDescription, nativeCode: nsError.code, nativeDomain: nsError.domain)
  }

  /// Why work that needs Bluetooth cannot run in `state`.
  init(unavailableIn state: CBManagerState) {
    switch state {
    case .unauthorized: self.init("unauthorized", "Bluetooth permission is not granted")
    case .unsupported: self.init("unsupported", "This device has no Bluetooth LE")
    default: self.init("bluetooth-off", "Bluetooth is off")
    }
  }

  var payload: [String: Any] {
    var payload: [String: Any] = ["code": code, "message": message]
    if let nativeCode { payload["nativeCode"] = nativeCode }
    if let nativeDomain { payload["nativeDomain"] = nativeDomain }
    return payload
  }
}

/// Elements of `object[key]` that really are `type`.
///
/// After a firmware update moves attribute handles, CoreBluetooth's cached arrays can hold objects of the wrong
/// class; Swift's typed bridging traps on them, so read the array through KVC and check each element.
func kvcArray<T: NSObject>(_ object: NSObject, _ key: String, of type: T.Type) -> [T] {
  guard let raw = object.value(forKey: key) as? NSArray else { return [] }
  return elements(raw, of: type)
}

/// Elements of `array` that really are `type`: the same check for arrays CoreBluetooth hands over directly.
func elements<T: NSObject>(_ array: NSArray, of type: T.Type) -> [T] {
  var result: [T] = []
  for element in array {
    let item = element as AnyObject
    if item.isKind(of: T.self) { result.append(unsafeDowncast(item, to: T.self)) }
  }
  return result
}

extension CBPeripheral {
  /// `services` without Swift's typed bridging, which traps on a stale cache.
  var checkedServices: [CBService] { kvcArray(self, "services", of: CBService.self) }

  /// A device as JS receives it: its id, and its name when it has one.
  var payload: [String: Any] {
    var device: [String: Any] = ["id": identifier.uuidString]
    if let name { device["name"] = name }
    return device
  }

  /// The services, characteristics and descriptors as JS receives them.
  var servicesPayload: [[String: Any]] {
    checkedServices.map { service in
      [
        "uuid": service.uuid.canonicalString,
        "isPrimary": service.isPrimary,
        "characteristics": service.checkedCharacteristics.map { characteristic in
          [
            "uuid": characteristic.uuid.canonicalString,
            "properties": characteristic.propertiesPayload,
            "descriptors": characteristic.checkedDescriptors.map(\.uuid.canonicalString),
          ] as [String: Any]
        },
      ] as [String: Any]
    }
  }
}

extension CBService {
  /// `characteristics` without Swift's typed bridging, which traps on a stale cache.
  var checkedCharacteristics: [CBCharacteristic] { kvcArray(self, "characteristics", of: CBCharacteristic.self) }
}

extension CBCharacteristic {
  /// `descriptors` without Swift's typed bridging, which traps on a stale cache.
  var checkedDescriptors: [CBDescriptor] { kvcArray(self, "descriptors", of: CBDescriptor.self) }

  var propertiesPayload: [String: Any] {
    [
      "broadcast": properties.contains(.broadcast),
      "read": properties.contains(.read),
      "writeWithoutResponse": properties.contains(.writeWithoutResponse),
      "write": properties.contains(.write),
      "notify": properties.contains(.notify),
      "indicate": properties.contains(.indicate),
      "authenticatedSignedWrites": properties.contains(.authenticatedSignedWrites),
      "extendedProperties": properties.contains(.extendedProperties),
    ]
  }
}

/// A descriptor value as bytes: CoreBluetooth decodes some well-known descriptors into strings and numbers.
func bytesOfDescriptorValue(_ value: Any?) -> Data {
  switch value {
  case let data as Data: return data
  case let string as String: return Data(string.utf8)
  case let number as NSNumber:
    var little = number.uint16Value.littleEndian
    return Data(bytes: &little, count: 2)
  default: return Data()
  }
}

extension CBManagerState {
  /// The state as JS names it.
  var name: String {
    switch self {
    case .unknown: return "unknown"
    case .resetting: return "resetting"
    case .unsupported: return "unsupported"
    case .unauthorized: return "unauthorized"
    case .poweredOff: return "off"
    case .poweredOn: return "on"
    @unknown default: return "unknown"
    }
  }
}

/// How much the library logs, from the most to the least.
enum LogLevel: Int, Comparable {
  case debug, info, warn, error, off

  /// The level JS names `name`.
  init?(name: String) {
    switch name {
    case "debug": self = .debug
    case "info": self = .info
    case "warn": self = .warn
    case "error": self = .error
    case "off": self = .off
    default: return nil
    }
  }

  var name: String {
    switch self {
    case .debug: return "debug"
    case .info: return "info"
    case .warn: return "warn"
    case .error: return "error"
    case .off: return "off"
    }
  }

  static func < (lhs: LogLevel, rhs: LogLevel) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// The longest attribute value ATT allows (Core spec Vol 3 Part F 3.2.9); CoreBluetooth splits longer-than-MTU
/// writes with response up to it.
let maxAttributeValueLength = 512
/// The ATT MTU before any exchange (Core spec Vol 3 Part F 3.2.8).
let defaultAttMtu = 23
/// Opcode and handle in front of every ATT write value.
let attWriteHeaderLength = 3
