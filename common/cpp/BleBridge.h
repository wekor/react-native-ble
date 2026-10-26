#pragma once

#include "BleValue.h"
#include "BleScanHub.h"

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>

namespace wekor::ble {

/**
 * The data plane shared by both platforms, one per module instance. JS reaches it through the
 * `__ReactNativeBleBindings` global it installs; the platform reaches it through its public methods.
 *
 * It holds no `jsi::Value`: the event handler lives in the JS heap as `__ReactNativeBleHandler`, so nothing
 * needs releasing when the runtime goes away. After `invalidate` it drops every late event.
 */
class BleBridge : public std::enable_shared_from_this<BleBridge> {
 public:
  static std::shared_ptr<BleBridge> create();
  ~BleBridge();

  void install(jsi::Runtime &runtime, const std::shared_ptr<facebook::react::CallInvoker> &callInvoker);
  void invalidate();

  /**
   * Any thread. Delivers `payload` to JS as `handler(type, payload)`, in call order. An `advertisement` goes
   * through the scan hub first and reaches JS as `scan` and `scanLost` events.
   */
  void emit(std::string type, Value payload);

  /** Any thread. Whether the scans drop every further advertisement of the device; see `BleScanHub::isDuplicate`. */
  bool isDuplicateAdvertisement(const std::string &deviceId);

  /** Any thread. Takes the bytes JS stored under `handle` with `putBytes`; each handle can be taken once. */
  std::optional<Bytes> takeBytes(int64_t handle);

 private:
  BleBridge() = default;

  void enqueue(std::string type, Value payload);
  /** JS thread: hands every queued event to the handler, in order. */
  void drain(jsi::Runtime &runtime);
  void emitAdvertisement(Value advertisement);
  /** Starts or stops the presence clock to match the running scans. */
  void updateTicker();
  void wakeTicker();
  void stopTicker();
  void stopTickerLocked();

  std::atomic<bool> alive_{true};
  std::weak_ptr<facebook::react::CallInvoker> callInvoker_;
  BleScanHub scanHub_;

  struct Event {
    std::string type;
    Value payload;
  };

  // Queued events are delivered by one JS-thread task rather than one task each.
  std::mutex eventsMutex_;
  std::vector<Event> events_;
  bool drainScheduled_ = false;
  /**
   * JS thread only. The batch being delivered, swapped with `events_` so both keep their capacity across batches;
   * `draining_` is set while it is in use, so a drain re-entered from the handler takes its own buffer.
   */
  std::vector<Event> drainBuffer_;
  bool draining_ = false;
  /**
   * Held from asking the hub about presence until its events are queued, by advertisement threads and the ticker,
   * so a device's loss and its next sighting reach JS in the order the hub saw them.
   */
  std::mutex presenceMutex_;

  // A device that stops advertising sends nothing, so a thread sleeps until the next device would count as lost
  // and reports it. It lives in native because JS timers stop while an Android app is in the background.
  std::mutex tickerControlMutex_; // starting and stopping
  std::mutex tickerMutex_;        // the thread's wait
  std::condition_variable tickerWake_;
  std::thread ticker_;
  bool tickerStopping_ = false;
  /** Set when a new device or scan may be lost sooner than the thread's current deadline. */
  bool tickerRecompute_ = false;

  std::mutex bytesMutex_;
  std::unordered_map<int64_t, Bytes> byteStore_;
  int64_t nextByteHandle_ = 1;
};

} // namespace wekor::ble
