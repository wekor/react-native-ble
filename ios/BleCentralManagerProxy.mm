#import "BleCentralManagerProxy.h"

#include "BleBridge.h"

#include <cstring>

#if __has_include("ReactNativeBle-Swift.h")
#import "ReactNativeBle-Swift.h"
#else
#import <ReactNativeBle/ReactNativeBle-Swift.h>
#endif

using wekor::ble::BleBridge;
using wekor::ble::Bytes;
using wekor::ble::Value;

namespace {

Value bytesOf(NSData *data) {
  auto start = static_cast<const uint8_t *>(data.bytes);
  return Value(Bytes(start, start + data.length));
}

/** What CoreBluetooth reports as the RSSI when it has none. */
constexpr NSInteger kCoreBluetoothRssiUnavailable = 127;

/** The Bluetooth base UUID, 0000xxxx-0000-1000-8000-00805f9b34fb, that 16- and 32-bit UUIDs expand into. */
constexpr uint8_t kBluetoothBaseUuid[16] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0x80, 0x5f, 0x9b, 0x34, 0xfb};

/** Lowercase and 128-bit, like every UUID the library hands out; CoreBluetooth keeps SIG UUIDs in short form. */
std::string canonicalUuid(CBUUID *uuid) {
  NSData *data = uuid.data;
  const NSUInteger length = data.length;
  uint8_t bytes[16];
  std::memcpy(bytes, kBluetoothBaseUuid, sizeof bytes);
  if (length == 2) {
    std::memcpy(bytes + 2, data.bytes, 2);
  } else if (length == 4 || length == 16) {
    std::memcpy(bytes, data.bytes, length);
  }
  static constexpr char kHexDigits[] = "0123456789abcdef";
  std::string text(36, '-');
  size_t at = 0;
  for (size_t i = 0; i < sizeof bytes; ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) ++at;
    text[at++] = kHexDigits[bytes[i] >> 4];
    text[at++] = kHexDigits[bytes[i] & 0x0f];
  }
  return text;
}

/** The UTF-8 bytes of `string`, without the autoreleased buffer `UTF8String` allocates. */
std::string stringOf(NSString *string) {
  if (const char *bytes = CFStringGetCStringPtr((__bridge CFStringRef)string, kCFStringEncodingUTF8)) return bytes;
  const NSUInteger capacity = [string maximumLengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  std::string text(capacity, '\0');
  NSUInteger used = 0;
  [string getBytes:text.data()
           maxLength:capacity
          usedLength:&used
            encoding:NSUTF8StringEncoding
             options:0
               range:NSMakeRange(0, string.length)
      remainingRange:nullptr];
  // Like `UTF8String`, the text ends at the first NUL.
  text.resize(strnlen(text.data(), used));
  return text;
}

Value uuidsOf(id list) {
  Value::Array uuids;
  if ([list isKindOfClass:[NSArray class]]) {
    NSArray *array = list;
    uuids.reserve(array.count);
    for (CBUUID *uuid in array) uuids.emplace_back(canonicalUuid(uuid));
  }
  return Value(std::move(uuids));
}

/** The `advertisement` event, read straight from CoreBluetooth's dictionary. */
Value advertisementOf(NSString *deviceId, CBPeripheral *peripheral, NSInteger rssi, NSDictionary *advertisementData) {
  Value::Object fields;
  fields.reserve(9);
  fields.emplace_back("deviceId", std::string(deviceId.UTF8String));
  fields.emplace_back("rssi", rssi == kCoreBluetoothRssiUnavailable ? wekor::ble::kRssiUnavailable : static_cast<int>(rssi));
  id name = advertisementData[CBAdvertisementDataLocalNameKey];
  if (![name isKindOfClass:[NSString class]]) name = peripheral.name;
  if (name) fields.emplace_back("name", stringOf(name));
  id manufacturerData = advertisementData[CBAdvertisementDataManufacturerDataKey];
  if ([manufacturerData isKindOfClass:[NSData class]]) fields.emplace_back("manufacturerData", bytesOf(manufacturerData));
  Value::Object serviceData;
  NSDictionary *serviceDataEntries = advertisementData[CBAdvertisementDataServiceDataKey];
  if ([serviceDataEntries isKindOfClass:[NSDictionary class]]) {
    serviceData.reserve(serviceDataEntries.count);
    for (CBUUID *uuid in serviceDataEntries) {
      id bytes = serviceDataEntries[uuid];
      if ([bytes isKindOfClass:[NSData class]]) serviceData.emplace_back(canonicalUuid(uuid), bytesOf(bytes));
    }
  }
  fields.emplace_back("serviceData", Value(std::move(serviceData)));
  fields.emplace_back("serviceUuids", uuidsOf(advertisementData[CBAdvertisementDataServiceUUIDsKey]));
  id txPower = advertisementData[CBAdvertisementDataTxPowerLevelKey];
  if ([txPower isKindOfClass:[NSNumber class]]) fields.emplace_back("txPowerLevel", [txPower doubleValue]);
  id connectable = advertisementData[CBAdvertisementDataIsConnectable];
  if ([connectable isKindOfClass:[NSNumber class]]) fields.emplace_back("isConnectable", static_cast<bool>([connectable boolValue]));
  Value::Object ios;
  ios.reserve(2);
  ios.emplace_back("overflowServiceUuids", uuidsOf(advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey]));
  ios.emplace_back("solicitedServiceUuids", uuidsOf(advertisementData[CBAdvertisementDataSolicitedServiceUUIDsKey]));
  fields.emplace_back("ios", Value(std::move(ios)));
  return Value(std::move(fields));
}

} // namespace

@implementation BleCentralManagerProxy {
  std::weak_ptr<BleBridge> _bridge;
}

- (instancetype)initWithBridge:(std::weak_ptr<BleBridge>)bridge
{
  if (self = [super init]) {
    _bridge = std::move(bridge);
  }
  return self;
}

- (void)centralManager:(CBCentralManager *)central
    didDiscoverPeripheral:(CBPeripheral *)peripheral
        advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                     RSSI:(NSNumber *)RSSI
{
  NSString *deviceId = [_central deviceIdForDiscovered:peripheral];
  if (!deviceId) return;
  if (auto bridge = _bridge.lock()) {
    bridge->emit("advertisement", advertisementOf(deviceId, peripheral, RSSI.integerValue, advertisementData));
  }
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central
{
  [_central centralManagerDidUpdateState:central];
}

- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral
{
  [_central centralManager:central didConnectPeripheral:peripheral];
}

- (void)centralManager:(CBCentralManager *)central
    didFailToConnectPeripheral:(CBPeripheral *)peripheral
                         error:(NSError *)error
{
  [_central centralManager:central didFailToConnectPeripheral:peripheral error:error];
}

- (void)centralManager:(CBCentralManager *)central
    didDisconnectPeripheral:(CBPeripheral *)peripheral
                      error:(NSError *)error
{
  [_central centralManager:central didDisconnectPeripheral:peripheral error:error];
}

- (void)centralManager:(CBCentralManager *)central willRestoreState:(NSDictionary<NSString *, id> *)dict
{
  [_central centralManager:central willRestoreState:dict];
}

- (void)centralManager:(CBCentralManager *)central didUpdateANCSAuthorizationForPeripheral:(CBPeripheral *)peripheral
{
  [_central centralManager:central didUpdateANCSAuthorizationForPeripheral:peripheral];
}

@end
