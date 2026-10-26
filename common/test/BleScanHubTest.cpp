// Unit tests for the scan hub, runtime-free: specs are built directly and advertisements are plain `Value`s.
// Run with `bun run test:cpp`.

#include "BleScanHub.h"

#include <algorithm>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

using namespace wekor::ble;

namespace {

int failures = 0;
const char *currentTest = "";

#define EXPECT(condition)                                                          \
  do {                                                                             \
    if (!(condition)) {                                                            \
      std::fprintf(stderr, "FAIL %s (line %d): %s\n", currentTest, __LINE__, #condition); \
      failures++;                                                                  \
    }                                                                              \
  } while (0)

void test(const char *name, const std::function<void()> &body) {
  currentTest = name;
  body();
}

const std::string kHeartRate = "0000180d-0000-1000-8000-00805f9b34fb";
const std::string kBattery = "0000180f-0000-1000-8000-00805f9b34fb";

struct Advertisement {
  std::string id = "A";
  double rssi = -50;
  std::optional<std::string> name;
  std::vector<std::string> services;
  std::optional<Bytes> manufacturerData;
  std::optional<std::vector<Bytes>> manufacturerEntries;
  std::vector<std::pair<std::string, Bytes>> serviceData;
  std::vector<std::string> solicited;

  Value build() const {
    Value::Object fields;
    fields.emplace_back("deviceId", id);
    fields.emplace_back("rssi", rssi);
    if (name) fields.emplace_back("name", *name);
    if (manufacturerData) fields.emplace_back("manufacturerData", *manufacturerData);
    Value::Object data;
    for (auto &[uuid, bytes] : serviceData) data.emplace_back(uuid, bytes);
    fields.emplace_back("serviceData", Value(std::move(data)));
    Value::Array uuids;
    for (auto &uuid : services) uuids.emplace_back(uuid);
    fields.emplace_back("serviceUuids", Value(std::move(uuids)));
    if (!solicited.empty()) {
      Value::Array uuids;
      for (auto &uuid : solicited) uuids.emplace_back(uuid);
      fields.emplace_back(
          "ios", Value(Value::Object{{"overflowServiceUuids", Value(Value::Array{})}, {"solicitedServiceUuids", Value(std::move(uuids))}}));
    }
    if (manufacturerEntries) {
      Value::Array entries;
      for (auto &entry : *manufacturerEntries) entries.emplace_back(entry);
      fields.emplace_back("android", Value(Value::Object{{"manufacturerEntries", Value(std::move(entries))}}));
    }
    return Value(std::move(fields));
  }
};

bool contains(const Value::Array &ids, int id) {
  return std::ranges::any_of(ids, [&](const Value &item) {
    auto number = item.asNumber();
    return number && *number == id;
  });
}

ScanFilter manufacturer(int companyId, Bytes manufacturerData = {}, Bytes mask = {}) {
  ScanFilter filter;
  filter.companyId = companyId;
  filter.manufacturerData = std::move(manufacturerData);
  filter.manufacturerMask = std::move(mask);
  return filter;
}

} // namespace

int main() {
  test("services filter by advertised UUID", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.services = {kHeartRate};
    hub.add(1, spec);
    EXPECT(contains(hub.onAdvertisement(Advertisement{.services = {kHeartRate}}.build(), 0).scanIds, 1));
    EXPECT(hub.onAdvertisement(Advertisement{.id = "B", .services = {kBattery}}.build(), 0).scanIds.empty());
  });

  test("service data counts as advertising the service", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.services = {kBattery};
    hub.add(1, spec);
    EXPECT(contains(hub.onAdvertisement(Advertisement{.serviceData = {{kBattery, {0x64}}}}.build(), 0).scanIds, 1));
  });

  test("duplicates are reported once unless allowed", [] {
    BleScanHub hub;
    hub.add(1, ScanSpec{});
    ScanSpec duplicates;
    duplicates.allowDuplicates = true;
    hub.add(2, duplicates);
    auto first = hub.onAdvertisement(Advertisement{}.build(), 0);
    auto second = hub.onAdvertisement(Advertisement{}.build(), 1);
    EXPECT(contains(first.scanIds, 1) && contains(first.scanIds, 2));
    EXPECT(!contains(second.scanIds, 1) && contains(second.scanIds, 2));
  });

  test("soliciting a requested solicited service matches services", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.services = {kHeartRate};
    spec.solicitedServices = {kBattery};
    hub.add(1, spec);
    EXPECT(contains(hub.onAdvertisement(Advertisement{.solicited = {kBattery}}.build(), 0).scanIds, 1));
    EXPECT(hub.onAdvertisement(Advertisement{.id = "B", .solicited = {kHeartRate}}.build(), 0).scanIds.empty());
    EXPECT(contains(hub.onAdvertisement(Advertisement{.id = "C", .services = {kHeartRate}}.build(), 0).scanIds, 1));
    // Soliciting is not advertising: a scan without solicited services ignores it.
    BleScanHub plain;
    ScanSpec battery;
    battery.services = {kBattery};
    plain.add(1, battery);
    EXPECT(plain.onAdvertisement(Advertisement{.solicited = {kBattery}}.build(), 0).scanIds.empty());
  });

  test("duplicates stay suppressed with bounded memory", [] {
    BleScanHub hub;
    hub.add(1, ScanSpec{});
    auto reported = [&](const std::string &id) { return contains(hub.onAdvertisement(Advertisement{.id = id}.build(), 0).scanIds, 1); };
    EXPECT(reported("steady"));
    // Far more devices than two generations hold; the steady one keeps advertising between them.
    for (size_t i = 0; i < BleScanHub::kReportedGenerationSize * 4; i++) {
      EXPECT(reported("device-" + std::to_string(i)));
      if (i % 100 == 0) EXPECT(!reported("steady"));
    }
    // A recent device is still remembered; one gone for longer than two generations is reported again.
    EXPECT(!reported("device-" + std::to_string(BleScanHub::kReportedGenerationSize * 4 - 1)));
    EXPECT(reported("device-0"));
  });

  test("a device every scan reported is a duplicate", [] {
    BleScanHub hub;
    EXPECT(!hub.isDuplicate("A"));
    ScanSpec spec;
    spec.services = {kHeartRate};
    hub.add(1, spec);
    hub.add(2, ScanSpec{});
    EXPECT(!hub.isDuplicate("A"));
    hub.onAdvertisement(Advertisement{.services = {kBattery}}.build(), 0);
    // Only scan 2 has it: what it advertises next may still match scan 1.
    EXPECT(!hub.isDuplicate("A"));
    hub.onAdvertisement(Advertisement{.services = {kHeartRate}}.build(), 0);
    EXPECT(hub.isDuplicate("A"));
    EXPECT(!hub.isDuplicate("B"));
  });

  test("duplicates and presence scans want every advertisement", [] {
    for (auto presence : {false, true}) {
      BleScanHub hub;
      hub.add(1, ScanSpec{});
      ScanSpec spec;
      spec.allowDuplicates = !presence;
      spec.tracksPresence = presence;
      spec.lostAfter = 1000;
      hub.add(2, spec);
      hub.onAdvertisement(Advertisement{}.build(), 0);
      EXPECT(!hub.isDuplicate("A"));
    }
  });

  test("a duplicate counts as hearing the device", [] {
    BleScanHub hub;
    hub.add(1, ScanSpec{});
    hub.onAdvertisement(Advertisement{.id = "steady"}.build(), 0);
    for (size_t i = 0; i < BleScanHub::kReportedGenerationSize * 4; i++) {
      hub.onAdvertisement(Advertisement{.id = "device-" + std::to_string(i)}.build(), 0);
      if (i % 100 == 0) EXPECT(hub.isDuplicate("steady"));
    }
    EXPECT(hub.onAdvertisement(Advertisement{.id = "steady"}.build(), 0).scanIds.empty());
  });

  test("reported ids rotate in generations: the previous one still deduplicates, the dropped one is reported again", [] {
    BleScanHub hub;
    hub.add(1, ScanSpec{});
    auto fill = [&](const std::string &prefix) {
      for (size_t i = 0; i < BleScanHub::kReportedGenerationSize; i++) {
        hub.onAdvertisement(Advertisement{.id = prefix + std::to_string(i)}.build(), 0);
      }
    };
    fill("first-");
    EXPECT(hub.onAdvertisement(Advertisement{.id = "first-0"}.build(), 0).scanIds.empty());
    fill("second-");
    fill("third-");
    EXPECT(contains(hub.onAdvertisement(Advertisement{.id = "first-1"}.build(), 0).scanIds, 1));
  });

  test("name and name prefix", [] {
    BleScanHub hub;
    ScanSpec spec;
    ScanFilter prefix;
    prefix.namePrefix = "Pin";
    spec.filters = {prefix};
    hub.add(1, spec);
    EXPECT(contains(hub.onAdvertisement(Advertisement{.name = "Pin-42"}.build(), 0).scanIds, 1));
    EXPECT(hub.onAdvertisement(Advertisement{.id = "B", .name = "Other"}.build(), 0).scanIds.empty());
    EXPECT(hub.onAdvertisement(Advertisement{.id = "C"}.build(), 0).scanIds.empty());
  });

  test("manufacturer data with mask", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.filters = {manufacturer(0x0059, {0x10, 0x20}, {0xf0})};
    hub.add(1, spec);
    // Company 0x0059 little-endian, then data; the mask compares the high nibble of the first byte only.
    EXPECT(contains(hub.onAdvertisement(Advertisement{.manufacturerData = Bytes{0x59, 0x00, 0x1f, 0x20}}.build(), 0).scanIds, 1));
    EXPECT(hub.onAdvertisement(Advertisement{.id = "B", .manufacturerData = Bytes{0x59, 0x00, 0x2f, 0x20}}.build(), 0).scanIds.empty());
    EXPECT(hub.onAdvertisement(Advertisement{.id = "C", .manufacturerData = Bytes{0x4c, 0x00, 0x10, 0x20}}.build(), 0).scanIds.empty());
    EXPECT(hub.onAdvertisement(Advertisement{.id = "D", .manufacturerData = Bytes{0x59}}.build(), 0).scanIds.empty());
  });

  test("any manufacturer entry matches on Android", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.filters = {manufacturer(0x0059)};
    hub.add(1, spec);
    Advertisement ad{.manufacturerData = Bytes{0x4c, 0x00, 0x01}, .manufacturerEntries = std::vector<Bytes>{{0x4c, 0x00, 0x01}, {0x59, 0x00, 0x02}}};
    EXPECT(contains(hub.onAdvertisement(ad.build(), 0).scanIds, 1));
  });

  test("service data with mask", [] {
    BleScanHub hub;
    ScanSpec spec;
    ScanFilter filter;
    filter.serviceDataUuid = kBattery;
    filter.serviceData = {0x60};
    filter.serviceDataMask = {0xf0};
    spec.filters = {filter};
    hub.add(1, spec);
    EXPECT(contains(hub.onAdvertisement(Advertisement{.serviceData = {{kBattery, {0x64}}}}.build(), 0).scanIds, 1));
    EXPECT(hub.onAdvertisement(Advertisement{.id = "B", .serviceData = {{kBattery, {0x54}}}}.build(), 0).scanIds.empty());
  });

  test("filters are alternatives", [] {
    BleScanHub hub;
    ScanSpec spec;
    ScanFilter name;
    name.name = "X";
    spec.filters = {name, manufacturer(0x0059)};
    hub.add(1, spec);
    EXPECT(contains(hub.onAdvertisement(Advertisement{.name = "X"}.build(), 0).scanIds, 1));
    EXPECT(contains(hub.onAdvertisement(Advertisement{.id = "B", .manufacturerData = Bytes{0x59, 0x00}}.build(), 0).scanIds, 1));
  });

  test("presence: found once, lost after lostAfter, found again", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.tracksPresence = true;
    spec.lostAfter = 1000;
    hub.add(1, spec);
    EXPECT(hub.tracksPresence());
    EXPECT(contains(hub.onAdvertisement(Advertisement{}.build(), 0).scanIds, 1));
    EXPECT(hub.onAdvertisement(Advertisement{}.build(), 500).scanIds.empty());
    EXPECT(hub.takeLostDevices(1400).empty());
    auto lost = hub.takeLostDevices(1500);
    EXPECT(lost.size() == 1 && lost[0].scanId == 1 && lost[0].deviceId == "A");
    EXPECT(contains(hub.onAdvertisement(Advertisement{}.build(), 1600).scanIds, 1));
  });

  test("presence: a device heard after lostAfter, before the ticker, is lost then found", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.tracksPresence = true;
    spec.lostAfter = 1000;
    hub.add(1, spec);
    hub.onAdvertisement(Advertisement{}.build(), 0);
    auto late = hub.onAdvertisement(Advertisement{}.build(), 1200);
    EXPECT(late.lost.size() == 1 && late.lost[0].scanId == 1 && late.lost[0].deviceId == "A");
    EXPECT(contains(late.scanIds, 1));
    // The loss is reported once: the ticker finds nothing left to report.
    EXPECT(hub.takeLostDevices(1300).empty());
  });

  test("presence: other devices' losses wait for the ticker", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.tracksPresence = true;
    spec.lostAfter = 1000;
    hub.add(1, spec);
    hub.onAdvertisement(Advertisement{}.build(), 0);
    EXPECT(hub.onAdvertisement(Advertisement{.id = "B"}.build(), 1500).lost.empty());
    auto lost = hub.takeLostDevices(1500);
    EXPECT(lost.size() == 1 && lost[0].deviceId == "A");
  });

  test("next loss is the earliest present device's", [] {
    BleScanHub hub;
    EXPECT(!hub.nextLossAt());
    ScanSpec slow;
    slow.tracksPresence = true;
    slow.lostAfter = 10000;
    hub.add(1, slow);
    ScanSpec fast;
    fast.tracksPresence = true;
    fast.lostAfter = 3000;
    fast.filters = {manufacturer(0x0059)};
    hub.add(2, fast);
    hub.onAdvertisement(Advertisement{.id = "A"}.build(), 0);
    EXPECT(hub.nextLossAt() == 10000);
    hub.onAdvertisement(Advertisement{.id = "B", .manufacturerData = Bytes{0x59, 0x00}}.build(), 5000);
    EXPECT(hub.nextLossAt() == 8000);
    hub.takeLostDevices(8000);
    EXPECT(hub.nextLossAt() == 10000);
    // Scan 1 has no filter, so it saw B at 5000 too.
    hub.takeLostDevices(10000);
    EXPECT(hub.nextLossAt() == 15000);
    hub.takeLostDevices(15000);
    EXPECT(!hub.nextLossAt());
  });

  test("minRssi drops weak advertisements, which keep no device present", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.tracksPresence = true;
    spec.minRssi = -70;
    spec.lostAfter = 1000;
    hub.add(1, spec);
    auto weak = hub.onAdvertisement(Advertisement{.rssi = -90}.build(), 0);
    EXPECT(weak.scanIds.empty() && !weak.presenceChanged);
    auto strong = hub.onAdvertisement(Advertisement{.rssi = -60}.build(), 1);
    EXPECT(contains(strong.scanIds, 1) && strong.presenceChanged);
    hub.onAdvertisement(Advertisement{.rssi = -90}.build(), 900);
    EXPECT(hub.takeLostDevices(1001).size() == 1);
  });

  test("without presence a device is reported once, even after a silence", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.lostAfter = 1000;
    hub.add(1, spec);
    EXPECT(contains(hub.onAdvertisement(Advertisement{}.build(), 0).scanIds, 1));
    EXPECT(hub.onAdvertisement(Advertisement{}.build(), 5000).scanIds.empty());
    EXPECT(!hub.tracksPresence());
  });

  test("duplicates with presence report every advertisement, and losses still", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.tracksPresence = true;
    spec.allowDuplicates = true;
    spec.lostAfter = 1000;
    hub.add(1, spec);
    auto first = hub.onAdvertisement(Advertisement{}.build(), 0);
    EXPECT(contains(first.scanIds, 1) && first.presenceChanged);
    auto again = hub.onAdvertisement(Advertisement{}.build(), 500);
    EXPECT(contains(again.scanIds, 1) && !again.presenceChanged);
    EXPECT(hub.takeLostDevices(1500).size() == 1);
  });

  test("merged config: services only when every scan has them", [] {
    BleScanHub hub;
    ScanSpec heart;
    heart.services = {kHeartRate};
    auto config = hub.add(1, heart);
    auto services = config.field("services");
    EXPECT(services && services->asArray() && services->asArray()->size() == 1);
    config = hub.add(2, ScanSpec{});
    EXPECT(config.field("services") && config.field("services")->isNull());
    EXPECT(hub.remove(1).field("services")->isNull());
    EXPECT(hub.remove(2).isNull());
  });

  test("merged config: duplicates when presence is tracked", [] {
    BleScanHub hub;
    ScanSpec spec;
    spec.tracksPresence = true;
    auto config = hub.add(1, spec);
    auto allow = config.field("allowDuplicates");
    EXPECT(allow && allow->asBool() && *allow->asBool());
  });

  test("merged config: a second scan starts a new report generation, and each scan sees a device once", [] {
    BleScanHub hub;
    ScanSpec heart;
    heart.services = {kHeartRate};
    auto allows = [](const Value &config) {
      auto allow = config.field("allowDuplicates");
      return allow && allow->asBool() && *allow->asBool();
    };
    auto generation = [](const Value &config) {
      auto ios = config.field("ios");
      auto value = ios ? ios->field("reportGeneration") : nullptr;
      return value && value->asNumber() ? *value->asNumber() : -1;
    };
    auto first = hub.add(1, heart);
    EXPECT(!allows(first));
    EXPECT(contains(hub.onAdvertisement(Advertisement{.services = {kHeartRate}}.build(), 0).scanIds, 1));
    // The system reports the device once per native scan: the second scan changes the config so iOS starts over.
    auto second = hub.add(2, heart);
    EXPECT(!allows(second) && generation(second) != generation(first));
    auto again = hub.onAdvertisement(Advertisement{.services = {kHeartRate}}.build(), 0);
    EXPECT(!contains(again.scanIds, 1) && contains(again.scanIds, 2));
    // Removing a scan needs no new report.
    EXPECT(generation(hub.remove(2)) == generation(second));
  });

  test("clear ends every scan", [] {
    BleScanHub hub;
    hub.add(1, ScanSpec{});
    hub.clear();
    EXPECT(hub.onAdvertisement(Advertisement{}.build(), 0).scanIds.empty());
    EXPECT(!hub.tracksPresence());
  });

  if (failures) {
    std::fprintf(stderr, "%d failed\n", failures);
    return 1;
  }
  std::printf("BleScanHub: all tests passed\n");
  return 0;
}
