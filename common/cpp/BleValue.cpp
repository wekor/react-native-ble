#include "BleValue.h"

namespace wekor::ble {

namespace {

class OwnedBuffer : public jsi::MutableBuffer {
 public:
  explicit OwnedBuffer(Bytes bytes) : bytes_(std::move(bytes)) {}
  size_t size() const override { return bytes_.size(); }
  uint8_t *data() override { return bytes_.data(); }

 private:
  Bytes bytes_;
};

} // namespace

const Value *Value::field(std::string_view key) const {
  auto object = asObject();
  if (!object) return nullptr;
  for (auto &[name, value] : *object) {
    if (name == key) return &value;
  }
  return nullptr;
}

jsi::Value Value::toJsi(jsi::Runtime &runtime) const {
  if (auto value = asBool()) return jsi::Value(*value);
  if (auto value = asNumber()) return jsi::Value(*value);
  if (auto value = asString()) return jsi::String::createFromUtf8(runtime, *value);
  if (auto value = asBytes()) {
    jsi::ArrayBuffer buffer(runtime, std::make_shared<OwnedBuffer>(*value));
    return runtime.global().getPropertyAsFunction(runtime, "Uint8Array").callAsConstructor(runtime, buffer);
  }
  if (auto value = asArray()) {
    jsi::Array array(runtime, value->size());
    for (size_t i = 0; i < value->size(); i++) array.setValueAtIndex(runtime, i, (*value)[i].toJsi(runtime));
    return array;
  }
  if (auto value = asObject()) {
    jsi::Object object(runtime);
    for (auto &[name, field] : *value) object.setProperty(runtime, jsi::PropNameID::forAscii(runtime, name), field.toJsi(runtime));
    return object;
  }
  return jsi::Value::null();
}

jsi::Value Value::moveToJsi(jsi::Runtime &runtime, const jsi::Function &uint8Array) {
  if (auto value = std::get_if<Bytes>(&data)) {
    jsi::ArrayBuffer buffer(runtime, std::make_shared<OwnedBuffer>(std::move(*value)));
    return uint8Array.callAsConstructor(runtime, buffer);
  }
  // Children shared with another value are copied rather than emptied.
  if (auto value = std::get_if<std::shared_ptr<Array>>(&data)) {
    auto &items = **value;
    bool owned = value->use_count() == 1;
    jsi::Array array(runtime, items.size());
    for (size_t i = 0; i < items.size(); i++) {
      array.setValueAtIndex(runtime, i, owned ? items[i].moveToJsi(runtime, uint8Array) : items[i].toJsi(runtime));
    }
    return array;
  }
  if (auto value = std::get_if<std::shared_ptr<Object>>(&data)) {
    bool owned = value->use_count() == 1;
    jsi::Object object(runtime);
    for (auto &[name, field] : **value) {
      object.setProperty(runtime, jsi::PropNameID::forAscii(runtime, name), owned ? field.moveToJsi(runtime, uint8Array) : field.toJsi(runtime));
    }
    return object;
  }
  return toJsi(runtime);
}

Value Value::fromJsi(jsi::Runtime &runtime, const jsi::Value &value) {
  if (value.isBool()) return Value(value.getBool());
  if (value.isNumber()) return Value(value.getNumber());
  if (value.isString()) return Value(value.getString(runtime).utf8(runtime));
  if (!value.isObject()) return Value();
  auto object = value.getObject(runtime);
  if (object.isFunction(runtime) || object.isArrayBuffer(runtime)) return Value();
  if (object.isArray(runtime)) {
    auto array = object.getArray(runtime);
    Array items;
    auto length = array.size(runtime);
    items.reserve(length);
    for (size_t i = 0; i < length; i++) items.push_back(fromJsi(runtime, array.getValueAtIndex(runtime, i)));
    return Value(std::move(items));
  }
  Object fields;
  auto names = object.getPropertyNames(runtime);
  auto length = names.size(runtime);
  for (size_t i = 0; i < length; i++) {
    auto name = names.getValueAtIndex(runtime, i).getString(runtime);
    auto field = object.getProperty(runtime, name);
    if (field.isUndefined()) continue;
    fields.emplace_back(name.utf8(runtime), fromJsi(runtime, field));
  }
  return Value(std::move(fields));
}

} // namespace wekor::ble
