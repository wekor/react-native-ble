#pragma once

#include <jsi/jsi.h>

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace wekor::ble {

namespace jsi = facebook::jsi;

using Bytes = std::vector<uint8_t>;

/**
 * A JS-shaped value that needs no runtime, so the platforms can build it on their Bluetooth thread; it becomes a
 * JS value only on the JS thread, with bytes as a `Uint8Array`.
 */
struct Value {
  using Array = std::vector<Value>;
  using Object = std::vector<std::pair<std::string, Value>>;

  std::variant<std::monostate, bool, double, std::string, Bytes, std::shared_ptr<Array>, std::shared_ptr<Object>> data;

  Value() = default;
  Value(bool value) : data(value) {}
  Value(double value) : data(value) {}
  Value(int value) : data(static_cast<double>(value)) {}
  Value(std::string value) : data(std::move(value)) {}
  Value(const char *value) : data(std::string(value)) {}
  Value(Bytes value) : data(std::move(value)) {}
  Value(Array value) : data(std::make_shared<Array>(std::move(value))) {}
  Value(Object value) : data(std::make_shared<Object>(std::move(value))) {}

  bool isNull() const { return std::holds_alternative<std::monostate>(data); }
  const bool *asBool() const { return std::get_if<bool>(&data); }
  const double *asNumber() const { return std::get_if<double>(&data); }
  const std::string *asString() const { return std::get_if<std::string>(&data); }
  const Bytes *asBytes() const { return std::get_if<Bytes>(&data); }
  const Array *asArray() const {
    auto array = std::get_if<std::shared_ptr<Array>>(&data);
    return array ? array->get() : nullptr;
  }
  const Object *asObject() const {
    auto object = std::get_if<std::shared_ptr<Object>>(&data);
    return object ? object->get() : nullptr;
  }

  /** The field `key` of an object, or nullptr. */
  const Value *field(std::string_view key) const;

  jsi::Value toJsi(jsi::Runtime &runtime) const;
  /**
   * Like `toJsi`, but moves its bytes into the `Uint8Array`s instead of copying; for a value used once.
   * `uint8Array` is the runtime's constructor, which the caller looks up once per batch.
   */
  jsi::Value moveToJsi(jsi::Runtime &runtime, const jsi::Function &uint8Array);
  /** Converts plain JS data only; functions and array buffers become null. */
  static Value fromJsi(jsi::Runtime &runtime, const jsi::Value &value);
};

// Queues and payload vectors move values; a throwing move would make them copy instead.
static_assert(std::is_nothrow_move_constructible_v<Value>);

} // namespace wekor::ble
