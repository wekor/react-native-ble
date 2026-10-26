#include "BleBridge.h"

#include <chrono>
#include <iterator>

namespace wekor::ble {

namespace {

constexpr const char *kGlobal = "__ReactNativeBleBindings";
constexpr const char *kHandler = "__ReactNativeBleHandler";
double nowMs() {
  using namespace std::chrono;
  // Not rounded: the ticker wakes at the exact loss instant and must not find the device a fraction early.
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

std::chrono::steady_clock::time_point timeOf(double ms) {
  using namespace std::chrono;
  return steady_clock::time_point(duration_cast<steady_clock::duration>(duration<double, std::milli>(ms)));
}

Bytes bytesOfTypedArray(jsi::Runtime &runtime, const jsi::Value &value) {
  auto notBytes = [&] { return jsi::JSError(runtime, "Expected a Uint8Array or ArrayBuffer"); };
  if (!value.isObject()) throw notBytes();
  auto object = value.getObject(runtime);
  if (object.isArrayBuffer(runtime)) {
    auto buffer = object.getArrayBuffer(runtime);
    auto data = buffer.data(runtime);
    return Bytes(data, data + buffer.size(runtime));
  }
  auto bufferValue = object.getProperty(runtime, jsi::PropNameID::forAscii(runtime, "buffer"));
  if (!bufferValue.isObject() || !bufferValue.getObject(runtime).isArrayBuffer(runtime)) throw notBytes();
  auto buffer = bufferValue.getObject(runtime).getArrayBuffer(runtime);
  auto offset = static_cast<size_t>(object.getProperty(runtime, jsi::PropNameID::forAscii(runtime, "byteOffset")).asNumber());
  auto length = static_cast<size_t>(object.getProperty(runtime, jsi::PropNameID::forAscii(runtime, "byteLength")).asNumber());
  auto data = buffer.data(runtime) + offset;
  return Bytes(data, data + length);
}

Value lostToValue(std::vector<LostDevice> lost) {
  Value::Array items;
  items.reserve(lost.size());
  for (auto &entry : lost) {
    Value::Object fields;
    fields.reserve(2);
    fields.emplace_back("scanId", entry.scanId);
    fields.emplace_back("deviceId", std::move(entry.deviceId));
    items.emplace_back(std::move(fields));
  }
  return Value(std::move(items));
}

} // namespace

std::shared_ptr<BleBridge> BleBridge::create() {
  return std::shared_ptr<BleBridge>(new BleBridge());
}

BleBridge::~BleBridge() {
  stopTicker();
}

void BleBridge::install(jsi::Runtime &runtime, const std::shared_ptr<facebook::react::CallInvoker> &callInvoker) {
  {
    // `enqueue` reads it from Bluetooth threads.
    std::lock_guard lock(eventsMutex_);
    callInvoker_ = callInvoker;
  }
  std::weak_ptr<BleBridge> weak = shared_from_this();
  jsi::Object api(runtime);

  auto function = [&](const char *name, unsigned int arguments, jsi::HostFunctionType body) {
    api.setProperty(runtime, name, jsi::Function::createFromHostFunction(runtime, jsi::PropNameID::forAscii(runtime, name), arguments, std::move(body)));
  };

  // putBytes(bytes) -> handle, for the native call that takes the bytes.
  function("putBytes", 1, [weak](jsi::Runtime &runtime, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
    auto self = weak.lock();
    if (!self || count < 1) return jsi::Value(0);
    auto bytes = bytesOfTypedArray(runtime, args[0]);
    std::lock_guard lock(self->bytesMutex_);
    auto handle = self->nextByteHandle_++;
    self->byteStore_.emplace(handle, std::move(bytes));
    return jsi::Value(static_cast<double>(handle));
  });

  // addScan(scanId, spec) -> merged native configuration.
  function("addScan", 2, [weak](jsi::Runtime &runtime, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
    auto self = weak.lock();
    if (!self || count < 2) return jsi::Value::null();
    auto spec = ScanSpec::fromJsi(runtime, args[1].getObject(runtime));
    auto config = self->scanHub_.add(static_cast<int>(args[0].asNumber()), std::move(spec));
    self->updateTicker();
    return config.toJsi(runtime);
  });

  // removeScan(scanId) -> merged native configuration, null when nothing scans.
  function("removeScan", 1, [weak](jsi::Runtime &runtime, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
    auto self = weak.lock();
    if (!self || count < 1) return jsi::Value::null();
    auto config = self->scanHub_.remove(static_cast<int>(args[0].asNumber()));
    self->updateTicker();
    return config.toJsi(runtime);
  });

  // clearScans(): the native scan failed, so every scan has ended.
  function("clearScans", 0, [weak](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
    if (auto self = weak.lock()) {
      self->scanHub_.clear();
      self->updateTicker();
    }
    return jsi::Value::undefined();
  });

  runtime.global().setProperty(runtime, kGlobal, std::move(api));
}

void BleBridge::invalidate() {
  alive_ = false;
  stopTicker();
  scanHub_.clear();
  std::lock_guard lock(bytesMutex_);
  byteStore_.clear();
}

void BleBridge::emit(std::string type, Value payload) {
  if (!alive_) return;
  if (type == "advertisement") return emitAdvertisement(std::move(payload));
  enqueue(std::move(type), std::move(payload));
}

bool BleBridge::isDuplicateAdvertisement(const std::string &deviceId) {
  return alive_ && scanHub_.isDuplicate(deviceId);
}

void BleBridge::emitAdvertisement(Value advertisement) {
  bool presenceChanged;
  {
    std::lock_guard presence(presenceMutex_);
    auto outcome = scanHub_.onAdvertisement(advertisement, nowMs());
    presenceChanged = outcome.presenceChanged;
    // A device lost and found by the same advertisement must reach JS lost first.
    if (!outcome.lost.empty()) enqueue("scanLost", lostToValue(std::move(outcome.lost)));
    if (!outcome.scanIds.empty()) {
      Value::Object scan;
      scan.reserve(2);
      scan.emplace_back("scanIds", std::move(outcome.scanIds));
      scan.emplace_back("advertisement", std::move(advertisement));
      enqueue("scan", Value(std::move(scan)));
    }
  }
  // A newly present device may be lost before the one the ticker is waiting for.
  if (presenceChanged) wakeTicker();
}

void BleBridge::wakeTicker() {
  {
    std::lock_guard lock(tickerMutex_);
    tickerRecompute_ = true;
  }
  tickerWake_.notify_one();
}

void BleBridge::updateTicker() {
  std::lock_guard control(tickerControlMutex_);
  if (!scanHub_.tracksPresence() || !alive_) return stopTickerLocked();
  // Already running: the scans changed, so the next loss time may have too.
  if (ticker_.joinable()) return wakeTicker();
  {
    // `wakeTicker` may be setting these from an advertisement thread.
    std::lock_guard lock(tickerMutex_);
    tickerStopping_ = false;
    tickerRecompute_ = false;
  }
  // Joined before the bridge is destroyed, so `this` outlives the thread.
  ticker_ = std::thread([this] {
    std::unique_lock lock(tickerMutex_);
    auto woken = [this] { return tickerStopping_ || tickerRecompute_; };
    while (!tickerStopping_) {
      // The hub takes its own lock, and nothing holds that lock while taking this one, so no deadlock.
      if (auto next = scanHub_.nextLossAt()) tickerWake_.wait_until(lock, timeOf(*next), woken);
      else tickerWake_.wait(lock, woken);
      tickerRecompute_ = false;
      if (tickerStopping_) break;
      lock.unlock();
      {
        std::lock_guard presence(presenceMutex_);
        auto lost = scanHub_.takeLostDevices(nowMs());
        if (!lost.empty() && alive_) enqueue("scanLost", lostToValue(std::move(lost)));
      }
      lock.lock();
    }
  });
}

void BleBridge::stopTicker() {
  std::lock_guard control(tickerControlMutex_);
  stopTickerLocked();
}

void BleBridge::stopTickerLocked() {
  if (!ticker_.joinable()) return;
  {
    std::lock_guard lock(tickerMutex_);
    tickerStopping_ = true;
  }
  tickerWake_.notify_one();
  ticker_.join();
}

void BleBridge::enqueue(std::string type, Value payload) {
  std::shared_ptr<facebook::react::CallInvoker> callInvoker;
  {
    std::lock_guard lock(eventsMutex_);
    callInvoker = callInvoker_.lock();
    if (!callInvoker) {
      // No JS runtime yet: drop the event, since nothing would ever drain the queue.
      return;
    }
    events_.push_back({std::move(type), std::move(payload)});
    if (drainScheduled_) return;
    drainScheduled_ = true;
  }
  std::weak_ptr<BleBridge> weak = weak_from_this();
  callInvoker->invokeAsync([weak](jsi::Runtime &runtime) {
    if (auto self = weak.lock()) self->drain(runtime);
  });
}

void BleBridge::drain(jsi::Runtime &runtime) {
  // A drain re-entered from the handler leaves the outer one's batch alone.
  std::vector<Event> nested;
  bool outermost = !draining_;
  auto &events = outermost ? drainBuffer_ : nested;
  {
    std::lock_guard lock(eventsMutex_);
    events.swap(events_);
    drainScheduled_ = false;
  }
  // Clears the batch however delivery ends, keeping its capacity, so a throwing handler can't leave events behind.
  struct Finish {
    std::vector<Event> &events;
    bool &draining;
    bool outermost;
    ~Finish() {
      events.clear();
      if (outermost) draining = false;
    }
  } finish{events, draining_, outermost};
  draining_ = true;

  if (!alive_ || events.empty()) return;
  auto handlerValue = runtime.global().getProperty(runtime, kHandler);
  if (!handlerValue.isObject()) return;
  auto handlerObject = std::move(handlerValue).getObject(runtime);
  if (!handlerObject.isFunction(runtime)) return;
  auto handler = std::move(handlerObject).getFunction(runtime);
  auto uint8Array = runtime.global().getPropertyAsFunction(runtime, "Uint8Array");
  // The type string is made once per run of events that share it.
  jsi::Value args[2];
  const std::string *argsType = nullptr;
  for (auto &event : events) {
    if (!argsType || *argsType != event.type) {
      args[0] = jsi::String::createFromUtf8(runtime, event.type);
      argsType = &event.type;
    }
    args[1] = event.payload.moveToJsi(runtime, uint8Array);
    handler.call(runtime, static_cast<const jsi::Value *>(args), std::size(args));
  }
}

std::optional<Bytes> BleBridge::takeBytes(int64_t handle) {
  std::lock_guard lock(bytesMutex_);
  auto node = byteStore_.extract(handle);
  if (node.empty()) return std::nullopt;
  return std::move(node.mapped());
}

} // namespace wekor::ble
