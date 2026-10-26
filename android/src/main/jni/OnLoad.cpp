#include "BleBridge.h"

#include <ReactCommon/BindingsInstallerHolder.h>
#include <fbjni/fbjni.h>

#include <limits>
#include <memory>
#include <optional>
#include <type_traits>
#include <vector>

using namespace facebook;
using wekor::ble::BleBridge;
using wekor::ble::Value;

namespace {

/**
 * The bridge behind the Kotlin side's `std::shared_ptr<BleBridge>*` Long. Kotlin holds a read lock across every
 * native call and `nativeDestroy` takes the write lock, so the pointer stays valid for the call it is passed to.
 */
std::shared_ptr<BleBridge> bridgeOf(jlong pointer) {
  if (pointer == 0) return nullptr;
  return *reinterpret_cast<std::shared_ptr<BleBridge> *>(pointer);
}

/** The classes and methods `valueOf` uses, resolved once; fbjni's method calls rethrow a pending Java exception. */
struct JavaTypes {
  jni::alias_ref<jni::JClass> string;
  jni::alias_ref<jni::JClass> boolean;
  jni::alias_ref<jni::JClass> number;
  jni::alias_ref<jni::JClass> bytes;
  jni::alias_ref<jni::JClass> map;
  jni::alias_ref<jni::JClass> list;
  jni::JMethod<jboolean()> booleanValue;
  jni::JMethod<jdouble()> doubleValue;
  jni::JMethod<jobject()> entrySet;
  jni::JMethod<jobject()> setIterator;
  jni::JMethod<jboolean()> hasNext;
  jni::JMethod<jobject()> next;
  jni::JMethod<jobject()> getKey;
  jni::JMethod<jobject()> getValue;
  jni::JMethod<jint()> listSize;
  jni::JMethod<jobject(jint)> listGet;
};

const JavaTypes &javaTypes() {
  static const JavaTypes instance = [] {
    JavaTypes types;
    // `findClassStatic` keeps a global reference for the life of the process.
    types.string = jni::findClassStatic("java/lang/String");
    types.boolean = jni::findClassStatic("java/lang/Boolean");
    types.number = jni::findClassStatic("java/lang/Number");
    types.bytes = jni::findClassStatic("[B");
    types.map = jni::findClassStatic("java/util/Map");
    types.list = jni::findClassStatic("java/util/List");
    types.booleanValue = types.boolean->getMethod<jboolean()>("booleanValue");
    types.doubleValue = types.number->getMethod<jdouble()>("doubleValue");
    types.entrySet = types.map->getMethod<jobject()>("entrySet", "()Ljava/util/Set;");
    types.setIterator = jni::findClassStatic("java/util/Set")->getMethod<jobject()>("iterator", "()Ljava/util/Iterator;");
    auto iterator = jni::findClassStatic("java/util/Iterator");
    types.hasNext = iterator->getMethod<jboolean()>("hasNext");
    types.next = iterator->getMethod<jobject()>("next");
    auto entry = jni::findClassStatic("java/util/Map$Entry");
    types.getKey = entry->getMethod<jobject()>("getKey");
    types.getValue = entry->getMethod<jobject()>("getValue");
    types.listSize = types.list->getMethod<jint()>("size");
    types.listGet = types.list->getMethod<jobject(jint)>("get");
    return types;
  }();
  return instance;
}

/** `com.wekor.reactnativeble.Advertisement`, so fbjni registers the native method with its real signature. */
struct JAdvertisement : jni::JavaClass<JAdvertisement> {
  static constexpr const char *kJavaDescriptor = "Lcom/wekor/reactnativeble/Advertisement;";
};

struct AdvertisementFields {
  jfieldID deviceId, name, rssi, manufacturerData, manufacturerEntries, serviceDataUuids, serviceDataValues, serviceUuids, txPowerLevel,
      connectable, scanRecord, isLegacy, primaryPhy, secondaryPhy, advertisingSid, periodicAdvertisingInterval,
      timestampNanos;
};

AdvertisementFields &advertisementFieldIds(JNIEnv *env) {
  static AdvertisementFields fields = [env] {
    jclass type = env->FindClass("com/wekor/reactnativeble/Advertisement");
    auto field = [&](const char *name, const char *signature) { return env->GetFieldID(type, name, signature); };
    AdvertisementFields advertisementFields{};
    advertisementFields.deviceId = field("deviceId", "Ljava/lang/String;");
    advertisementFields.name = field("name", "Ljava/lang/String;");
    advertisementFields.rssi = field("rssi", "I");
    advertisementFields.manufacturerData = field("manufacturerData", "[B");
    advertisementFields.manufacturerEntries = field("manufacturerEntries", "[[B");
    advertisementFields.serviceDataUuids = field("serviceDataUuids", "[Ljava/lang/String;");
    advertisementFields.serviceDataValues = field("serviceDataValues", "[[B");
    advertisementFields.serviceUuids = field("serviceUuids", "[Ljava/lang/String;");
    advertisementFields.txPowerLevel = field("txPowerLevel", "I");
    advertisementFields.connectable = field("connectable", "I");
    advertisementFields.scanRecord = field("scanRecord", "[B");
    advertisementFields.isLegacy = field("isLegacy", "Z");
    advertisementFields.primaryPhy = field("primaryPhy", "Ljava/lang/String;");
    advertisementFields.secondaryPhy = field("secondaryPhy", "Ljava/lang/String;");
    advertisementFields.advertisingSid = field("advertisingSid", "I");
    advertisementFields.periodicAdvertisingInterval = field("periodicAdvertisingInterval", "I");
    advertisementFields.timestampNanos = field("timestampNanos", "J");
    env->DeleteLocalRef(type);
    return advertisementFields;
  }();
  return fields;
}

/** Deletes a JNI local reference with the env it came from, so releasing it costs no thread-local lookup. */
struct LocalRefDeleter {
  JNIEnv *env;
  void operator()(jobject reference) const { env->DeleteLocalRef(reference); }
};

/** A JNI local reference owned for the scope that holds it. */
template <typename T>
using LocalRef = std::unique_ptr<std::remove_pointer_t<T>, LocalRefDeleter>;

template <typename T>
LocalRef<T> objectField(JNIEnv *env, jobject object, jfieldID field) {
  return LocalRef<T>(static_cast<T>(env->GetObjectField(object, field)), LocalRefDeleter{env});
}

template <typename T>
LocalRef<T> arrayElement(JNIEnv *env, jobjectArray array, jsize index) {
  return LocalRef<T>(static_cast<T>(env->GetObjectArrayElement(array, index)), LocalRefDeleter{env});
}

std::string stringOf(jstring string) {
  return jni::wrap_alias(string)->toStdString();
}

/** The first `count` bytes of `array`. */
wekor::ble::Bytes bytesOf(JNIEnv *env, jbyteArray array, jsize count) {
  wekor::ble::Bytes bytes(count);
  if (count > 0) env->GetByteArrayRegion(array, 0, count, reinterpret_cast<jbyte *>(bytes.data()));
  return bytes;
}

wekor::ble::Bytes bytesOf(JNIEnv *env, jbyteArray array) {
  return bytesOf(env, array, env->GetArrayLength(array));
}

/** Copies a Kotlin payload (Map, List, String, Number, Boolean, ByteArray, null) into a runtime-free Value. */
Value valueOf(JNIEnv *env, jni::alias_ref<jobject> object) {
  if (!object) return Value();
  auto &types = javaTypes();
  if (object->isInstanceOf(types.string)) return Value(stringOf(static_cast<jstring>(object.get())));
  if (object->isInstanceOf(types.boolean)) return Value(static_cast<bool>(types.booleanValue(object)));
  if (object->isInstanceOf(types.number)) return Value(types.doubleValue(object));
  if (object->isInstanceOf(types.bytes)) return Value(bytesOf(env, static_cast<jbyteArray>(object.get())));
  if (object->isInstanceOf(types.list)) {
    Value::Array items;
    jint size = types.listSize(object);
    items.reserve(size);
    for (jint i = 0; i < size; i++) items.push_back(valueOf(env, types.listGet(object, i)));
    return Value(std::move(items));
  }
  if (object->isInstanceOf(types.map)) {
    Value::Object fields;
    auto iterator = types.setIterator(types.entrySet(object));
    while (types.hasNext(iterator)) {
      auto entry = types.next(iterator);
      auto key = types.getKey(entry);
      if (key && key->isInstanceOf(types.string)) {
        fields.emplace_back(stringOf(static_cast<jstring>(key.get())), valueOf(env, types.getValue(entry)));
      }
    }
    return Value(std::move(fields));
  }
  return Value();
}

class JBleModule : public jni::JavaClass<JBleModule> {
 public:
  static constexpr const char *kJavaDescriptor = "Lcom/wekor/reactnativeble/BleModule;";

  static void registerNatives() {
    javaClassLocal()->registerNatives({
        makeNativeMethod("nativeBindingsInstaller", JBleModule::nativeBindingsInstaller),
        makeNativeMethod("nativeCreate", JBleModule::nativeCreate),
        makeNativeMethod("nativeDestroy", JBleModule::nativeDestroy),
        makeNativeMethod("nativeEmit", JBleModule::nativeEmit),
        makeNativeMethod("nativeEmitResult", JBleModule::nativeEmitResult),
        makeNativeMethod("nativeEmitAdvertisement", JBleModule::nativeEmitAdvertisement),
        makeNativeMethod("nativeIsDuplicateAdvertisement", JBleModule::nativeIsDuplicateAdvertisement),
        makeNativeMethod("nativeEmitNotification", JBleModule::nativeEmitNotification),
        makeNativeMethod("nativeEmitL2capData", JBleModule::nativeEmitL2capData),
        makeNativeMethod("nativeTakeBytes", JBleModule::nativeTakeBytes),
    });
  }

 private:
  static jni::local_ref<react::BindingsInstallerHolder::javaobject> nativeBindingsInstaller(
      jni::alias_ref<JBleModule>, jlong pointer) {
    // A copy: the installer runs later, outside the read lock that keeps the holder alive.
    std::shared_ptr<BleBridge> bridge = pointer ? *reinterpret_cast<std::shared_ptr<BleBridge> *>(pointer) : nullptr;
    return react::BindingsInstallerHolder::newObjectCxxArgs(
        [bridge](jsi::Runtime &runtime, const std::shared_ptr<react::CallInvoker> &callInvoker) {
          if (bridge) bridge->install(runtime, callInvoker);
        });
  }

  static jlong nativeCreate(jni::alias_ref<JBleModule>) {
    return reinterpret_cast<jlong>(new std::shared_ptr<BleBridge>(BleBridge::create()));
  }

  static void nativeDestroy(jni::alias_ref<JBleModule>, jlong pointer) {
    if (pointer == 0) return;
    auto holder = reinterpret_cast<std::shared_ptr<BleBridge> *>(pointer);
    (*holder)->invalidate();
    delete holder;
  }

  static void nativeEmit(jni::alias_ref<JBleModule>, jlong pointer, jni::alias_ref<jstring> type, jni::alias_ref<jobject> payload) {
    auto bridge = bridgeOf(pointer);
    if (!bridge) return;
    JNIEnv *env = jni::Environment::current();
    bridge->emit(type->toStdString(), valueOf(env, payload));
  }

  /** `{ opId, value }` or `{ opId, error }`, built here instead of from a Java Map. */
  static void nativeEmitResult(
      jni::alias_ref<JBleModule>, jlong pointer, jdouble opId, jni::alias_ref<jobject> value, jni::alias_ref<jobject> error) {
    auto bridge = bridgeOf(pointer);
    if (!bridge) return;
    JNIEnv *env = jni::Environment::current();
    Value::Object fields;
    fields.reserve(2);
    fields.emplace_back("opId", static_cast<double>(opId));
    if (error) fields.emplace_back("error", valueOf(env, error));
    else if (value) fields.emplace_back("value", valueOf(env, value));
    bridge->emit("result", Value(std::move(fields)));
  }

  /** `{ deviceId, service, characteristic, value }`, built here instead of from a Java Map. */
  static void nativeEmitNotification(
      jni::alias_ref<JBleModule>,
      jlong pointer,
      jni::alias_ref<jstring> deviceId,
      jni::alias_ref<jstring> service,
      jni::alias_ref<jstring> characteristic,
      jni::alias_ref<jni::JArrayByte> value) {
    auto bridge = bridgeOf(pointer);
    if (!bridge) return;
    JNIEnv *env = jni::Environment::current();
    Value::Object fields;
    fields.reserve(4);
    fields.emplace_back("deviceId", deviceId->toStdString());
    fields.emplace_back("service", service->toStdString());
    fields.emplace_back("characteristic", characteristic->toStdString());
    fields.emplace_back("value", bytesOf(env, value.get()));
    bridge->emit("notification", Value(std::move(fields)));
  }

  /** `{ channelId, value }` with the first `count` bytes of the reader's buffer, copied once. */
  static void nativeEmitL2capData(
      jni::alias_ref<JBleModule>, jlong pointer, jint channelId, jni::alias_ref<jni::JArrayByte> buffer, jint count) {
    auto bridge = bridgeOf(pointer);
    if (!bridge) return;
    JNIEnv *env = jni::Environment::current();
    Value::Object fields;
    fields.reserve(2);
    fields.emplace_back("channelId", static_cast<double>(channelId));
    fields.emplace_back("value", bytesOf(env, buffer.get(), count));
    bridge->emit("l2capData", Value(std::move(fields)));
  }

  /**
   * Asked before Kotlin builds an `Advertisement`: whether every scan reported the device already and drops whatever
   * else it advertises, so it need not be built. Counts as hearing the device.
   */
  static jboolean nativeIsDuplicateAdvertisement(jni::alias_ref<JBleModule>, jlong pointer, jni::alias_ref<jstring> deviceId) {
    auto bridge = bridgeOf(pointer);
    return bridge && bridge->isDuplicateAdvertisement(deviceId->toStdString());
  }

  /** The JS `advertisement` event, built from one `Advertisement` read field by field; absent fields are left out. */
  static void nativeEmitAdvertisement(jni::alias_ref<JBleModule>, jlong pointer, jni::alias_ref<JAdvertisement> advertisement) {
    auto bridge = bridgeOf(pointer);
    if (!bridge) return;
    JNIEnv *env = jni::Environment::current();
    auto &advertisementFields = advertisementFieldIds(env);
    jobject object = advertisement.get();

    auto string = [&](jfieldID field) -> std::optional<std::string> {
      auto value = objectField<jstring>(env, object, field);
      if (!value) return std::nullopt;
      return stringOf(value.get());
    };
    auto byteField = [&](jfieldID field) -> std::optional<wekor::ble::Bytes> {
      auto array = objectField<jbyteArray>(env, object, field);
      if (!array) return std::nullopt;
      return bytesOf(env, array.get());
    };
    auto optionalInt = [&](jfieldID field) -> std::optional<int> {
      jint value = env->GetIntField(object, field);
      if (value == std::numeric_limits<jint>::min()) return std::nullopt;
      return value;
    };

    Value::Object serviceData;
    {
      auto uuids = objectField<jobjectArray>(env, object, advertisementFields.serviceDataUuids);
      auto values = objectField<jobjectArray>(env, object, advertisementFields.serviceDataValues);
      jsize length = env->GetArrayLength(uuids.get());
      serviceData.reserve(length);
      for (jsize i = 0; i < length; i++) {
        auto uuid = arrayElement<jstring>(env, uuids.get(), i);
        auto bytes = arrayElement<jbyteArray>(env, values.get(), i);
        serviceData.emplace_back(stringOf(uuid.get()), bytesOf(env, bytes.get()));
      }
    }
    Value::Array serviceUuids;
    {
      auto uuids = objectField<jobjectArray>(env, object, advertisementFields.serviceUuids);
      jsize length = env->GetArrayLength(uuids.get());
      serviceUuids.reserve(length);
      for (jsize i = 0; i < length; i++) serviceUuids.emplace_back(stringOf(arrayElement<jstring>(env, uuids.get(), i).get()));
    }
    Value::Array manufacturerEntries;
    {
      auto entries = objectField<jobjectArray>(env, object, advertisementFields.manufacturerEntries);
      jsize length = env->GetArrayLength(entries.get());
      manufacturerEntries.reserve(length);
      for (jsize i = 0; i < length; i++) manufacturerEntries.emplace_back(bytesOf(env, arrayElement<jbyteArray>(env, entries.get(), i).get()));
    }

    Value::Object android;
    android.reserve(8);
    if (auto record = byteField(advertisementFields.scanRecord)) android.emplace_back("scanRecord", std::move(*record));
    android.emplace_back("manufacturerEntries", Value(std::move(manufacturerEntries)));
    android.emplace_back("timestampNanos", static_cast<double>(env->GetLongField(object, advertisementFields.timestampNanos)));
    android.emplace_back("isLegacy", static_cast<bool>(env->GetBooleanField(object, advertisementFields.isLegacy)));
    android.emplace_back("primaryPhy", string(advertisementFields.primaryPhy).value_or("le1m"));
    if (auto phy = string(advertisementFields.secondaryPhy)) android.emplace_back("secondaryPhy", std::move(*phy));
    if (auto sid = optionalInt(advertisementFields.advertisingSid)) android.emplace_back("advertisingSid", *sid);
    if (auto interval = optionalInt(advertisementFields.periodicAdvertisingInterval)) {
      android.emplace_back("periodicAdvertisingInterval", *interval);
    }

    Value::Object fields;
    fields.reserve(9);
    fields.emplace_back("deviceId", string(advertisementFields.deviceId).value_or(""));
    if (auto name = string(advertisementFields.name)) fields.emplace_back("name", std::move(*name));
    fields.emplace_back("rssi", static_cast<int>(env->GetIntField(object, advertisementFields.rssi)));
    if (auto data = byteField(advertisementFields.manufacturerData)) fields.emplace_back("manufacturerData", std::move(*data));
    fields.emplace_back("serviceData", Value(std::move(serviceData)));
    fields.emplace_back("serviceUuids", Value(std::move(serviceUuids)));
    if (auto power = optionalInt(advertisementFields.txPowerLevel)) fields.emplace_back("txPowerLevel", *power);
    if (jint connectable = env->GetIntField(object, advertisementFields.connectable); connectable != std::numeric_limits<jint>::min()) {
      fields.emplace_back("isConnectable", connectable == 1);
    }
    fields.emplace_back("android", Value(std::move(android)));
    bridge->emit("advertisement", Value(std::move(fields)));
  }

  static jni::local_ref<jni::JArrayByte> nativeTakeBytes(jni::alias_ref<JBleModule>, jlong pointer, jlong handle) {
    auto bridge = bridgeOf(pointer);
    if (!bridge) return nullptr;
    auto bytes = bridge->takeBytes(handle);
    if (!bytes) return nullptr;
    auto array = jni::JArrayByte::newArray(bytes->size());
    array->setRegion(0, static_cast<jsize>(bytes->size()), reinterpret_cast<const jbyte *>(bytes->data()));
    return array;
  }
};

} // namespace

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  return jni::initialize(vm, [] { JBleModule::registerNatives(); });
}
