#import <CoreBluetooth/CoreBluetooth.h>

#include <memory>

@class BleCentral;

namespace wekor::ble {
class BleBridge;
}

NS_ASSUME_NONNULL_BEGIN

/**
 * The central manager's delegate. Advertisements become C++ values for the bridge here, in Objective-C++: the
 * Swift signature of `didDiscover` would first bridge every advertisement dictionary into a Swift one. Every other
 * event goes to the central.
 */
@interface BleCentralManagerProxy : NSObject <CBCentralManagerDelegate>

@property (nonatomic, weak, nullable) BleCentral *central;

- (instancetype)initWithBridge:(std::weak_ptr<wekor::ble::BleBridge>)bridge NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@end

NS_ASSUME_NONNULL_END
