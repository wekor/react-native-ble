#import "ReactNativeBle.h"

#import "BleCentralManagerProxy.h"

#include "BleBridge.h"

#if __has_include("ReactNativeBle-Swift.h")
#import "ReactNativeBle-Swift.h"
#else
#import <ReactNativeBle/ReactNativeBle-Swift.h>
#endif

using wekor::ble::BleBridge;
using wekor::ble::Bytes;
using wekor::ble::Value;

namespace {

/** `count` bytes at `bytes` as a JS `Uint8Array` value, copied once. */
Value bytesOf(const void *bytes, NSInteger count) {
  auto start = static_cast<const uint8_t *>(bytes);
  return Value(count > 0 ? Bytes(start, start + count) : Bytes());
}

Value bytesOf(NSData *data) {
  return bytesOf(data.bytes, static_cast<NSInteger>(data.length));
}

Value valueOf(id object) {
  if (object == nil || object == [NSNull null]) return Value();
  if ([object isKindOfClass:[NSNumber class]]) {
    if (CFGetTypeID((__bridge CFTypeRef)object) == CFBooleanGetTypeID()) return Value(static_cast<bool>([object boolValue]));
    return Value([object doubleValue]);
  }
  if ([object isKindOfClass:[NSString class]]) return Value(std::string([object UTF8String]));
  if ([object isKindOfClass:[NSData class]]) return bytesOf(object);
  if ([object isKindOfClass:[NSArray class]]) {
    NSArray *array = object;
    Value::Array items;
    items.reserve(array.count);
    for (id item in array) items.push_back(valueOf(item));
    return Value(std::move(items));
  }
  if ([object isKindOfClass:[NSDictionary class]]) {
    NSDictionary<NSString *, id> *dictionary = object;
    Value::Object fields;
    fields.reserve(dictionary.count);
    // Through a pointer: a block captures a C++ object as a const copy.
    Value::Object *out = &fields;
    [dictionary enumerateKeysAndObjectsUsingBlock:^(NSString *key, id value, BOOL *) {
      out->emplace_back(std::string(key.UTF8String), valueOf(value));
    }];
    return Value(std::move(fields));
  }
  return Value();
}

} // namespace

@interface ReactNativeBle () <BleCentralDelegate>
@end

@implementation ReactNativeBle {
  std::shared_ptr<BleBridge> _bridge;
  BleCentral *_central;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    _bridge = BleBridge::create();
    BleCentralManagerProxy *managerProxy = [[BleCentralManagerProxy alloc] initWithBridge:_bridge];
    _central = [[BleCentral alloc] initWithDelegate:self managerDelegate:managerProxy];
    managerProxy.central = _central;
  }
  return self;
}

#pragma mark - BleCentralDelegate

- (void)emit:(NSString *)type payload:(NSDictionary<NSString *, id> *)payload
{
  _bridge->emit(std::string(type.UTF8String), valueOf(payload));
}

- (void)emitResult:(double)opId value:(id)value error:(NSDictionary<NSString *, id> *)error
{
  Value::Object fields;
  fields.reserve(2);
  fields.emplace_back("opId", opId);
  if (error) fields.emplace_back("error", valueOf(error));
  else if (value) fields.emplace_back("value", valueOf(value));
  _bridge->emit("result", Value(std::move(fields)));
}

- (void)emitNotification:(NSString *)deviceId
                 service:(NSString *)service
          characteristic:(NSString *)characteristic
                   bytes:(const void *)bytes
                   count:(NSInteger)count
{
  // Built field by field: an initializer list would copy the bytes.
  Value::Object fields;
  fields.reserve(4);
  fields.emplace_back("deviceId", std::string(deviceId.UTF8String));
  fields.emplace_back("service", std::string(service.UTF8String));
  fields.emplace_back("characteristic", std::string(characteristic.UTF8String));
  fields.emplace_back("value", bytesOf(bytes, count));
  _bridge->emit("notification", Value(std::move(fields)));
}

- (void)emitL2capData:(NSInteger)channelId bytes:(const void *)bytes count:(NSInteger)count
{
  Value::Object fields;
  fields.reserve(2);
  fields.emplace_back("channelId", static_cast<double>(channelId));
  fields.emplace_back("value", bytesOf(bytes, count));
  _bridge->emit("l2capData", Value(std::move(fields)));
}

- (NSData *)takeBytes:(double)handle
{
  auto bytes = _bridge->takeBytes(static_cast<int64_t>(handle));
  if (!bytes) return nil;
  if (bytes->empty()) return [NSData data];
  // The NSData takes over the bytes instead of copying them.
  auto owned = new Bytes(std::move(*bytes));
  return [[NSData alloc] initWithBytesNoCopy:owned->data()
                                      length:owned->size()
                                 deallocator:^(void *, NSUInteger) {
                                   delete owned;
                                 }];
}

- (void)installJSIBindingsWithRuntime:(facebook::jsi::Runtime &)runtime
                          callInvoker:(const std::shared_ptr<facebook::react::CallInvoker> &)callInvoker
{
  _bridge->install(runtime, callInvoker);
}

- (void)invalidate
{
  [_central invalidate];
  _bridge->invalidate();
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeReactNativeBleSpecJSI>(params);
}

#pragma mark - Adapter

- (NSNumber *)configure:(NSDictionary *)options
{
  [_central configure:options];
  return @YES;
}

- (NSString *)getState
{
  return [_central getState];
}

- (NSNumber *)getPermission:(double)opId
{
  [_central getPermission:opId];
  return @YES;
}

- (NSNumber *)requestPermission:(double)opId
{
  [_central requestPermission:opId];
  return @YES;
}

- (NSNumber *)setScan:(NSDictionary *)config
{
  [_central setScan:config];
  return @YES;
}

#pragma mark - Device

- (NSNumber *)connect:(double)opId deviceId:(NSString *)deviceId options:(NSDictionary *)options
{
  [_central connect:opId deviceId:deviceId options:options];
  return @YES;
}

- (NSNumber *)disconnect:(double)opId deviceId:(NSString *)deviceId
{
  [_central disconnect:opId deviceId:deviceId];
  return @YES;
}

- (NSNumber *)read:(double)opId
          deviceId:(NSString *)deviceId
           service:(NSString *)service
    characteristic:(NSString *)characteristic
           timeout:(double)timeout
{
  [_central read:opId deviceId:deviceId service:service characteristic:characteristic timeout:timeout];
  return @YES;
}

- (NSNumber *)write:(double)opId
           deviceId:(NSString *)deviceId
            service:(NSString *)service
     characteristic:(NSString *)characteristic
        valueHandle:(double)valueHandle
    withoutResponse:(BOOL)withoutResponse
            timeout:(double)timeout
{
  [_central write:opId
             deviceId:deviceId
              service:service
       characteristic:characteristic
          valueHandle:valueHandle
      withoutResponse:withoutResponse
              timeout:timeout];
  return @YES;
}

- (NSNumber *)setNotify:(double)opId
               deviceId:(NSString *)deviceId
                service:(NSString *)service
         characteristic:(NSString *)characteristic
                 enable:(BOOL)enable
               indicate:(BOOL)indicate
                timeout:(double)timeout
{
  [_central setNotify:opId
             deviceId:deviceId
              service:service
       characteristic:characteristic
               enable:enable
              timeout:timeout];
  return @YES;
}

- (NSNumber *)readDescriptor:(double)opId
                    deviceId:(NSString *)deviceId
                     service:(NSString *)service
              characteristic:(NSString *)characteristic
                  descriptor:(NSString *)descriptor
                     timeout:(double)timeout
{
  [_central readDescriptor:opId
                  deviceId:deviceId
                   service:service
            characteristic:characteristic
                descriptor:descriptor
                   timeout:timeout];
  return @YES;
}

- (NSNumber *)writeDescriptor:(double)opId
                     deviceId:(NSString *)deviceId
                      service:(NSString *)service
               characteristic:(NSString *)characteristic
                   descriptor:(NSString *)descriptor
                  valueHandle:(double)valueHandle
                      timeout:(double)timeout
{
  [_central writeDescriptor:opId
                   deviceId:deviceId
                    service:service
             characteristic:characteristic
                 descriptor:descriptor
                valueHandle:valueHandle
                    timeout:timeout];
  return @YES;
}

- (NSNumber *)readRssi:(double)opId deviceId:(NSString *)deviceId timeout:(double)timeout
{
  [_central readRssi:opId deviceId:deviceId timeout:timeout];
  return @YES;
}

- (NSNumber *)rediscoverServices:(double)opId deviceId:(NSString *)deviceId timeout:(double)timeout
{
  [_central rediscoverServices:opId deviceId:deviceId timeout:timeout];
  return @YES;
}

- (NSNumber *)maxWriteLength:(NSString *)deviceId withoutResponse:(BOOL)withoutResponse
{
  return @([_central maxWriteLength:deviceId withoutResponse:withoutResponse]);
}

- (NSNumber *)getConnectedDevices:(double)opId services:(NSArray *)services
{
  [_central getConnectedDevices:opId services:services];
  return @YES;
}

#pragma mark - L2CAP

- (NSNumber *)openL2capChannel:(double)opId deviceId:(NSString *)deviceId psm:(double)psm secure:(BOOL)secure timeout:(double)timeout
{
  [_central openL2capChannel:opId deviceId:deviceId psm:psm timeout:timeout];
  return @YES;
}

- (NSNumber *)writeL2capChannel:(double)opId channelId:(double)channelId valueHandle:(double)valueHandle
{
  [_central writeL2capChannel:opId channelId:channelId valueHandle:valueHandle];
  return @YES;
}

- (NSNumber *)closeL2capChannel:(double)opId channelId:(double)channelId
{
  [_central closeL2capChannel:opId channelId:channelId];
  return @YES;
}

#pragma mark - Android only

- (NSNumber *)requestEnable:(double)opId
{
  [_central unsupported:opId];
  return @YES;
}

- (NSNumber *)getBondedDevices:(double)opId
{
  [_central unsupported:opId];
  return @YES;
}

- (NSNumber *)requestMtu:(double)opId deviceId:(NSString *)deviceId mtu:(double)mtu timeout:(double)timeout
{
  [_central unsupported:opId];
  return @YES;
}

- (NSNumber *)requestPriority:(double)opId deviceId:(NSString *)deviceId priority:(NSString *)priority
{
  [_central unsupported:opId];
  return @YES;
}

- (NSNumber *)setPhy:(double)opId deviceId:(NSString *)deviceId options:(NSDictionary *)options timeout:(double)timeout
{
  [_central unsupported:opId];
  return @YES;
}

- (NSNumber *)readPhy:(double)opId deviceId:(NSString *)deviceId timeout:(double)timeout
{
  [_central unsupported:opId];
  return @YES;
}

- (NSNumber *)bond:(double)opId deviceId:(NSString *)deviceId
{
  [_central unsupported:opId];
  return @YES;
}

- (NSNumber *)unbond:(double)opId deviceId:(NSString *)deviceId
{
  [_central unsupported:opId];
  return @YES;
}

- (NSString *)getBondState:(NSString *)deviceId
{
  return @"none";
}

- (NSNumber *)refreshCache:(double)opId deviceId:(NSString *)deviceId timeout:(double)timeout
{
  [_central unsupported:opId];
  return @YES;
}

#pragma mark - iOS only

- (NSNumber *)getAncsAuthorized:(NSString *)deviceId
{
  return @([_central getAncsAuthorized:deviceId]);
}

@end
