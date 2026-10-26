#pragma once

#include "BleValue.h"

#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace wekor::ble {

/** The RSSI reported when the platform has none: the lowest value, so it never passes an RSSI threshold. */
constexpr int kRssiUnavailable = -127;

struct ScanFilter {
  std::optional<std::string> name;
  std::optional<std::string> namePrefix;
  std::optional<int> companyId;
  Bytes manufacturerData;
  Bytes manufacturerMask;
  std::optional<std::string> serviceDataUuid;
  Bytes serviceData;
  Bytes serviceDataMask;
};

/** One `startScan()` call, with UUIDs already normalized by JS to lowercase 128-bit. */
struct ScanSpec {
  std::vector<std::string> services;
  std::vector<ScanFilter> filters;
  bool allowDuplicates = false;
  /** Set when the scan has `onLost`: a device is then reported again after each loss. */
  bool tracksPresence = false;
  std::optional<double> minRssi;
  /** Always set by JS, which fills in the default. */
  double lostAfter = 0;
  Value android;
  /** iOS: devices soliciting one of these match `services` too. */
  std::vector<std::string> solicitedServices;

  static ScanSpec fromJsi(jsi::Runtime &runtime, const jsi::Object &spec);
};

struct LostDevice {
  int scanId;
  std::string deviceId;
};

/** What one advertisement means for the running scans. */
struct AdvertisementOutcome {
  /** The ids of the scans that report it, as numbers, ready for the `scan` event. */
  Value::Array scanIds;
  std::vector<LostDevice> lost;
  /** A device became present in some scan, so the earliest loss may have moved. */
  bool presenceChanged = false;
};

/**
 * Matches advertisements against every running scan (filters, duplicates, presence) for both platforms. The
 * platform runs one native scan with the merged configuration and feeds every advertisement in here.
 */
class BleScanHub {
 public:
  /**
   * How many reported ids a scan without duplicates keeps per generation. A device dropped from both
   * generations is reported again, the price of bounding memory for scans that run for hours.
   */
  static constexpr size_t kReportedGenerationSize = 512;

  /** Adds or replaces a scan; returns the merged native configuration. */
  Value add(int scanId, ScanSpec spec);
  /** Returns the merged native configuration, null once no scan is left. */
  Value remove(int scanId);
  void clear();
  /** Whether some scan has `onLost`, so lost devices must be checked for on a timer. */
  bool tracksPresence();

  AdvertisementOutcome onAdvertisement(const Value &advertisement, double nowMs);
  /**
   * Whether every scan reported the device already and drops whatever else it advertises, so the platform can
   * skip building the advertisement. Counts as hearing the device again, which keeps it deduplicated.
   */
  bool isDuplicate(const std::string &deviceId);
  std::vector<LostDevice> takeLostDevices(double nowMs);
  /** When the next present device will count as lost if it stays silent; empty when none is present. */
  std::optional<double> nextLossAt();

 private:
  /**
   * Ids already reported, bounded because a scan can see a new random address every few seconds for hours.
   * Inserts go to `current`; when it fills, it becomes `previous`, dropping the older generation. An id seen
   * again moves to `current`, so a device advertising steadily stays deduplicated.
   */
  class ReportedDeviceIds {
   public:
    /** Records `id`; returns true if it was new. */
    bool insert(const std::string &id);
    bool contains(const std::string &id) const;

   private:
    std::unordered_set<std::string> current_;
    std::unordered_set<std::string> previous_;
  };
  struct Scan {
    ScanSpec spec;
    ReportedDeviceIds reported;
    /** When each present device was last heard, in ms. */
    std::unordered_map<std::string, double> present;
  };

  Value merged();

  std::mutex mutex_;
  std::map<int, Scan> scans_;
  /**
   * Grows when a scan joins running ones. iOS reports each device once per native scan, so the scans running
   * already have heard devices the new one would not: a new value makes iOS start the native scan over, which
   * reports every device again, and each scan skips the ones it has. Android reports every advertisement anyway.
   */
  int reportGeneration_ = 0;
};

} // namespace wekor::ble
