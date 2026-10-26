#include "BleScanHub.h"

#include <algorithm>
#include <array>
#include <set>
#include <span>
#include <string_view>

namespace wekor::ble {

namespace {

/** If `value` is an array, reserves room for its items in `out` and calls `each` with every one. */
template <typename Container, typename Each>
void forEachItem(jsi::Runtime &runtime, const jsi::Value &value, Container &out, Each each) {
  if (!value.isObject()) return;
  auto object = value.getObject(runtime);
  if (!object.isArray(runtime)) return;
  auto array = std::move(object).getArray(runtime);
  auto length = array.size(runtime);
  out.reserve(length);
  for (size_t i = 0; i < length; i++) each(array.getValueAtIndex(runtime, i));
}

std::vector<std::string> stringsOf(jsi::Runtime &runtime, const jsi::Value &value) {
  std::vector<std::string> strings;
  forEachItem(runtime, value, strings, [&](const jsi::Value &item) {
    if (item.isString()) strings.push_back(item.getString(runtime).utf8(runtime));
  });
  return strings;
}

Bytes bytesOf(jsi::Runtime &runtime, const jsi::Value &value) {
  Bytes bytes;
  forEachItem(runtime, value, bytes, [&](const jsi::Value &item) { bytes.push_back(static_cast<uint8_t>(item.asNumber())); });
  return bytes;
}

std::optional<std::string> optionalString(jsi::Runtime &runtime, const jsi::Object &object, const char *name) {
  auto value = object.getProperty(runtime, name);
  if (!value.isString()) return std::nullopt;
  return value.getString(runtime).utf8(runtime);
}

/** Whether `actual` starts with `expected`, comparing only bits set in `mask`; bytes past the mask compare fully. */
bool hasMaskedPrefix(std::span<const uint8_t> actual, const Bytes &expected, const Bytes &mask) {
  if (actual.size() < expected.size()) return false;
  for (size_t i = 0; i < expected.size(); i++) {
    uint8_t bits = i < mask.size() ? mask[i] : 0xff;
    if ((actual[i] & bits) != (expected[i] & bits)) return false;
  }
  return true;
}

/** `entry` is a little-endian company id followed by data; both must match the filter, data through its mask. */
bool manufacturerEntryMatches(const ScanFilter &filter, const Bytes &entry) {
  if (entry.size() < 2) return false;
  int companyId = entry[0] | (entry[1] << 8);
  if (companyId != *filter.companyId) return false;
  return hasMaskedPrefix(std::span(entry).subspan(2), filter.manufacturerData, filter.manufacturerMask);
}

/**
 * Whether `predicate` holds for some manufacturer entry. Android lists every entry in
 * `android.manufacturerEntries`; iOS reports only one, as `manufacturerData`.
 */
template <typename Predicate>
bool anyManufacturerEntry(const Value &advertisement, Predicate predicate) {
  auto android = advertisement.field("android");
  if (auto entries = android ? android->field("manufacturerEntries") : nullptr) {
    if (auto array = entries->asArray()) {
      for (auto &entry : *array) {
        if (auto bytes = entry.asBytes(); bytes && predicate(*bytes)) return true;
      }
      return false;
    }
  }
  auto manufacturerData = advertisement.field("manufacturerData");
  auto bytes = manufacturerData ? manufacturerData->asBytes() : nullptr;
  return bytes && predicate(*bytes);
}

bool matchesFilter(const ScanFilter &filter, const Value &advertisement) {
  auto name = advertisement.field("name");
  auto nameString = name ? name->asString() : nullptr;
  if (filter.name && (!nameString || *nameString != *filter.name)) return false;
  if (filter.namePrefix && (!nameString || !nameString->starts_with(*filter.namePrefix))) return false;
  if (filter.companyId && !anyManufacturerEntry(advertisement, [&](const Bytes &entry) {
        return manufacturerEntryMatches(filter, entry);
      })) {
    return false;
  }
  if (filter.serviceDataUuid) {
    auto serviceData = advertisement.field("serviceData");
    auto entry = serviceData ? serviceData->field(*filter.serviceDataUuid) : nullptr;
    auto bytes = entry ? entry->asBytes() : nullptr;
    if (!bytes || !hasMaskedPrefix(*bytes, filter.serviceData, filter.serviceDataMask)) {
      return false;
    }
  }
  return true;
}

/** Whether `uuids`, an array of strings, holds `uuid`. */
bool listsUuid(const Value *uuids, const std::string &uuid) {
  auto array = uuids ? uuids->asArray() : nullptr;
  if (!array) return false;
  return std::ranges::any_of(*array, [&](auto &item) {
    auto string = item.asString();
    return string && *string == uuid;
  });
}

bool advertises(const Value &advertisement, const std::string &service) {
  auto ios = advertisement.field("ios");
  if (listsUuid(advertisement.field("serviceUuids"), service)) return true;
  if (ios && listsUuid(ios->field("overflowServiceUuids"), service)) return true;
  auto serviceData = advertisement.field("serviceData");
  return serviceData && serviceData->field(service);
}

bool solicits(const Value &advertisement, const std::string &service) {
  auto ios = advertisement.field("ios");
  return ios && listsUuid(ios->field("solicitedServiceUuids"), service);
}

bool matchesSpec(const ScanSpec &spec, const Value &advertisement) {
  auto anyService = [&](auto &services, auto predicate) {
    return std::ranges::any_of(services, [&](auto &service) { return predicate(advertisement, service); });
  };
  // A device soliciting one of `solicitedServices` counts as advertising a wanted service.
  if (!spec.services.empty() && !anyService(spec.services, advertises) && !anyService(spec.solicitedServices, solicits)) {
    return false;
  }
  if (spec.filters.empty()) return true;
  return std::ranges::any_of(spec.filters, [&](auto &filter) { return matchesFilter(filter, advertisement); });
}

/** The string option `key` of the scan's Android options, if set. */
const std::string *androidOption(const ScanSpec &spec, std::string_view key) {
  auto value = spec.android.field(key);
  return value ? value->asString() : nullptr;
}

/** Android scan modes ranked by duty cycle, so merging picks the most demanding. */
constexpr std::array<std::string_view, 4> kScanModes = {"opportunistic", "low-power", "balanced", "low-latency"};
constexpr size_t kMostDemandingScanMode = kScanModes.size() - 1;

size_t scanModeRank(std::string_view mode) {
  for (size_t rank = 0; rank < kMostDemandingScanMode; rank++) {
    if (mode == kScanModes[rank]) return rank;
  }
  return kMostDemandingScanMode;
}

/** `filter` as a hardware filter the Bluetooth controller can apply, or nothing if it cannot express it. */
std::optional<Value> hardwareFilterOf(const ScanFilter &filter) {
  if (filter.namePrefix) return std::nullopt;
  Value::Object fields;
  if (filter.name) fields.emplace_back("name", *filter.name);
  if (filter.companyId) {
    fields.emplace_back("companyId", *filter.companyId);
    fields.emplace_back("manufacturerData", filter.manufacturerData);
    fields.emplace_back("manufacturerMask", filter.manufacturerMask);
  }
  if (filter.serviceDataUuid) {
    fields.emplace_back("serviceDataUuid", *filter.serviceDataUuid);
    fields.emplace_back("serviceData", filter.serviceData);
    fields.emplace_back("serviceDataMask", filter.serviceDataMask);
  }
  if (fields.empty()) return std::nullopt;
  return Value(std::move(fields));
}

} // namespace

// The spec comes from the library's own JS, which always builds it whole, so fields aren't validated.
ScanSpec ScanSpec::fromJsi(jsi::Runtime &runtime, const jsi::Object &spec) {
  ScanSpec result;
  result.services = stringsOf(runtime, spec.getProperty(runtime, "services"));
  forEachItem(runtime, spec.getProperty(runtime, "filters"), result.filters, [&](const jsi::Value &item) {
    auto object = item.getObject(runtime);
    ScanFilter filter;
    filter.name = optionalString(runtime, object, "name");
    filter.namePrefix = optionalString(runtime, object, "namePrefix");
    auto companyId = object.getProperty(runtime, "companyId");
    if (companyId.isNumber()) filter.companyId = static_cast<int>(companyId.getNumber());
    filter.manufacturerData = bytesOf(runtime, object.getProperty(runtime, "manufacturerData"));
    filter.manufacturerMask = bytesOf(runtime, object.getProperty(runtime, "manufacturerMask"));
    filter.serviceDataUuid = optionalString(runtime, object, "serviceDataUuid");
    filter.serviceData = bytesOf(runtime, object.getProperty(runtime, "serviceData"));
    filter.serviceDataMask = bytesOf(runtime, object.getProperty(runtime, "serviceDataMask"));
    result.filters.push_back(std::move(filter));
  });
  auto allowDuplicates = spec.getProperty(runtime, "allowDuplicates");
  result.allowDuplicates = allowDuplicates.isBool() && allowDuplicates.getBool();
  auto tracksPresence = spec.getProperty(runtime, "tracksPresence");
  result.tracksPresence = tracksPresence.isBool() && tracksPresence.getBool();
  auto minRssi = spec.getProperty(runtime, "minRssi");
  if (minRssi.isNumber()) result.minRssi = minRssi.getNumber();
  result.lostAfter = spec.getProperty(runtime, "lostAfter").asNumber();
  result.android = Value::fromJsi(runtime, spec.getProperty(runtime, "android"));
  auto ios = spec.getProperty(runtime, "ios").getObject(runtime);
  result.solicitedServices = stringsOf(runtime, ios.getProperty(runtime, "solicitedServices"));
  return result;
}

bool BleScanHub::ReportedDeviceIds::insert(const std::string &id) {
  if (!current_.insert(id).second) return false;
  bool seen = previous_.erase(id) > 0;
  if (current_.size() >= kReportedGenerationSize) {
    // The dropped generation's buckets serve the new one, so rotating allocates no table.
    previous_.swap(current_);
    current_.clear();
  }
  return !seen;
}

bool BleScanHub::ReportedDeviceIds::contains(const std::string &id) const {
  return current_.contains(id) || previous_.contains(id);
}

Value BleScanHub::add(int scanId, ScanSpec spec) {
  std::lock_guard lock(mutex_);
  if (!scans_.empty()) reportGeneration_++;
  scans_[scanId] = Scan{std::move(spec), {}, {}};
  return merged();
}

Value BleScanHub::remove(int scanId) {
  std::lock_guard lock(mutex_);
  scans_.erase(scanId);
  return merged();
}

void BleScanHub::clear() {
  std::lock_guard lock(mutex_);
  scans_.clear();
}

bool BleScanHub::tracksPresence() {
  std::lock_guard lock(mutex_);
  return std::ranges::any_of(scans_, [](auto &entry) { return entry.second.spec.tracksPresence; });
}

AdvertisementOutcome BleScanHub::onAdvertisement(const Value &advertisement, double nowMs) {
  std::lock_guard lock(mutex_);
  AdvertisementOutcome outcome;
  auto id = advertisement.field("deviceId");
  auto deviceId = id ? id->asString() : nullptr;
  if (!deviceId) return outcome;
  auto rssiValue = advertisement.field("rssi");
  double rssi = rssiValue && rssiValue->asNumber() ? *rssiValue->asNumber() : kRssiUnavailable;

  for (auto &[scanId, scan] : scans_) {
    if (!matchesSpec(scan.spec, advertisement)) continue;
    if (scan.spec.minRssi && rssi < *scan.spec.minRssi) continue;
    bool found;
    if (scan.spec.tracksPresence) {
      auto [entry, inserted] = scan.present.try_emplace(*deviceId, nowMs);
      // Silent for `lostAfter`, but heard again before the ticker reported it: it was lost, and is found again.
      if (!inserted && nowMs - entry->second >= scan.spec.lostAfter) {
        outcome.lost.push_back({scanId, *deviceId});
        inserted = true;
      }
      entry->second = nowMs;
      found = inserted;
      outcome.presenceChanged = outcome.presenceChanged || inserted;
    } else {
      found = scan.reported.insert(*deviceId);
    }
    if (found || scan.spec.allowDuplicates) outcome.scanIds.emplace_back(scanId);
  }
  // Other devices' losses are the ticker's: it wakes when the earliest one is due.
  return outcome;
}

bool BleScanHub::isDuplicate(const std::string &deviceId) {
  std::lock_guard lock(mutex_);
  if (scans_.empty()) return false;
  for (auto &[scanId, scan] : scans_) {
    // Duplicates and presence want every advertisement.
    if (scan.spec.allowDuplicates || scan.spec.tracksPresence || !scan.reported.contains(deviceId)) return false;
  }
  for (auto &[scanId, scan] : scans_) scan.reported.insert(deviceId);
  return true;
}

std::vector<LostDevice> BleScanHub::takeLostDevices(double nowMs) {
  std::lock_guard lock(mutex_);
  std::vector<LostDevice> lost;
  for (auto &[scanId, scan] : scans_) {
    for (auto it = scan.present.begin(); it != scan.present.end();) {
      if (nowMs - it->second < scan.spec.lostAfter) {
        ++it;
        continue;
      }
      lost.push_back({scanId, it->first});
      it = scan.present.erase(it);
    }
  }
  return lost;
}

std::optional<double> BleScanHub::nextLossAt() {
  std::lock_guard lock(mutex_);
  std::optional<double> next;
  for (auto &[scanId, scan] : scans_) {
    for (auto &[deviceId, lastSeen] : scan.present) {
      double at = lastSeen + scan.spec.lostAfter;
      if (!next || at < *next) next = at;
    }
  }
  return next;
}

Value BleScanHub::merged() {
  if (scans_.empty()) return Value();

  bool everyHasServices = true;
  bool allowDuplicates = false;
  bool legacy = true;
  size_t foreground = 0;
  size_t background = 0;
  double reportDelay = -1;
  std::set<std::string> services;
  std::set<std::string> solicited;
  std::set<std::string> phys;
  Value::Array hardwareFilters;
  bool hardwareFiltersComplete = true;

  for (auto &[scanId, scan] : scans_) {
    auto &spec = scan.spec;
    allowDuplicates = allowDuplicates || spec.allowDuplicates || spec.tracksPresence;
    for (auto &service : spec.services) services.insert(service);
    for (auto &service : spec.solicitedServices) solicited.insert(service);

    if (spec.services.empty()) {
      everyHasServices = false;
      // The controller can still filter a scan without services if every one of its filters is expressible.
      if (spec.filters.empty()) hardwareFiltersComplete = false;
      for (auto &filter : spec.filters) {
        auto hardware = hardwareFilterOf(filter);
        if (hardware) hardwareFilters.push_back(std::move(*hardware));
        else hardwareFiltersComplete = false;
      }
    }

    auto mode = androidOption(spec, "scanMode");
    std::string_view scanMode = mode ? std::string_view(*mode) : "auto";
    auto foregroundRank = scanModeRank(scanMode == "auto" ? "low-latency" : scanMode);
    auto backgroundRank = scanModeRank(scanMode == "auto" ? "low-power" : scanMode);
    foreground = std::max(foreground, foregroundRank);
    background = std::max(background, backgroundRank);

    auto delay = spec.android.field("reportDelay");
    double scanDelay = delay && delay->asNumber() ? *delay->asNumber() : 0;
    reportDelay = reportDelay < 0 ? scanDelay : std::min(reportDelay, scanDelay);

    auto legacyValue = spec.android.field("legacy");
    if (legacyValue && legacyValue->asBool() && !*legacyValue->asBool()) legacy = false;

    auto phy = androidOption(spec, "phy");
    phys.insert(phy ? *phy : "le1m");
  }

  Value::Object android;
  android.emplace_back("scanMode", Value(Value::Object{{"foreground", std::string(kScanModes[foreground])}, {"background", std::string(kScanModes[background])}}));
  android.emplace_back("reportDelay", reportDelay < 0 ? 0.0 : reportDelay);
  android.emplace_back("legacy", legacy);
  android.emplace_back("phy", phys.size() == 1 ? Value(*phys.begin()) : Value("all"));

  Value::Array serviceList;
  for (auto &service : services) serviceList.emplace_back(service);

  if (!everyHasServices && hardwareFiltersComplete) {
    for (auto &service : services) hardwareFilters.push_back(Value(Value::Object{{"serviceUuid", service}}));
    android.emplace_back("filters", Value(std::move(hardwareFilters)));
  } else {
    android.emplace_back("filters", Value());
  }

  Value::Array solicitedList;
  for (auto &service : solicited) solicitedList.emplace_back(service);

  Value::Object config;
  // Null services means some scan wants every device.
  config.emplace_back("services", everyHasServices ? Value(std::move(serviceList)) : Value());
  config.emplace_back("allowDuplicates", allowDuplicates);
  config.emplace_back("android", Value(std::move(android)));
  config.emplace_back(
      "ios",
      Value(Value::Object{
          {"solicitedServices", Value(std::move(solicitedList))},
          {"reportGeneration", reportGeneration_},
      }));
  return Value(std::move(config));
}

} // namespace wekor::ble
