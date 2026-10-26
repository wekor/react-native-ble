import { Platform } from 'react-native';
import { deviceOf } from './device';
import { errorOf } from './errors';
import {
  bindings,
  type NativeAdvertisement,
  native,
  setEventHandler,
} from './native';
import type { ScanFilter, ScanOptions, ScanResult } from './types';
import { normalizeUuid } from './uuid';

const DEFAULT_LOST_AFTER = 10_000;

let nextScanId = 1;
const scans = new Map<number, ScanOptions>();

const toByteArray = (value?: Uint8Array) =>
  value ? Array.from(value) : undefined;

/** Flattens a filter into the plain fields the native scan matcher reads. */
const filterSpecOf = ({
  name,
  namePrefix,
  manufacturerData,
  serviceData,
}: ScanFilter) => ({
  name,
  namePrefix,
  companyId: manufacturerData?.companyId,
  manufacturerData: toByteArray(manufacturerData?.data),
  manufacturerMask: toByteArray(manufacturerData?.mask),
  serviceDataUuid: serviceData ? normalizeUuid(serviceData.uuid) : undefined,
  serviceData: toByteArray(serviceData?.data),
  serviceDataMask: toByteArray(serviceData?.mask),
});

/** The latest merged config, while a send is queued for the end of the JS task. */
let queuedConfig: { config: object | null } | undefined;

/**
 * Sends the merged native config at most once per JS task, so starting and stopping several scans together (as
 * a render often does) restarts the native scan once; Android allows only 5 scan starts per 30 s.
 */
const scheduleSetScan = (config: object | null) => {
  if (queuedConfig) {
    queuedConfig.config = config;
    return;
  }
  const batch = { config };
  queuedConfig = batch;
  Promise.resolve().then(() => {
    queuedConfig = undefined;
    native.setScan(batch.config);
  });
};

// Presence needs every advertisement, which costs iOS duplicate reporting, so only a scan with `onLost` tracks it.
const tracksPresence = (options: ScanOptions) => !!options.onLost;

export const startScan = (options: ScanOptions): (() => void) => {
  const scanId = nextScanId++;
  const spec = {
    services: (options.services ?? []).map(normalizeUuid),
    filters: (options.filters ?? []).map(filterSpecOf),
    allowDuplicates: options.allowDuplicates ?? false,
    tracksPresence: tracksPresence(options),
    minRssi: options.minRssi,
    lostAfter: options.lostAfter ?? DEFAULT_LOST_AFTER,
    android: options.android ?? {},
    ios: {
      solicitedServices: (options.ios?.solicitedServices ?? []).map(
        normalizeUuid
      ),
    },
  };
  scans.set(scanId, options);
  scheduleSetScan(bindings().addScan(scanId, spec));

  return () => {
    if (!scans.delete(scanId)) return;
    scheduleSetScan(bindings().removeScan(scanId));
  };
};

// The name goes to the device, which keeps the last known one; the result has no copy of it.
const resultOf = ({
  deviceId,
  name,
  android,
  ios,
  ...fields
}: NativeAdvertisement): ScanResult => ({
  device: deviceOf(deviceId, name),
  ...fields,
  ...(Platform.OS === 'android' && android ? { android } : {}),
  ...(Platform.OS === 'ios' && ios ? { ios } : {}),
});

/** A copy of the result with its own bytes and arrays, so one consumer changing them cannot reach another. */
const copyOf = ({
  manufacturerData,
  serviceData,
  serviceUuids,
  android,
  ios,
  ...fields
}: ScanResult): ScanResult => ({
  ...fields,
  ...(manufacturerData ? { manufacturerData: manufacturerData.slice() } : {}),
  serviceData: Object.fromEntries(
    Object.entries(serviceData).map(([uuid, data]) => [uuid, data.slice()])
  ),
  serviceUuids: [...serviceUuids],
  ...(android
    ? {
        android: {
          ...android,
          manufacturerEntries: android.manufacturerEntries.map((entry) =>
            entry.slice()
          ),
          scanRecord: android.scanRecord.slice(),
        },
      }
    : {}),
  ...(ios
    ? {
        ios: {
          overflowServiceUuids: [...ios.overflowServiceUuids],
          solicitedServiceUuids: [...ios.solicitedServiceUuids],
        },
      }
    : {}),
});

setEventHandler('scan', ({ scanIds, advertisement }) => {
  const consumers = scanIds.filter((scanId) => scans.get(scanId)?.onFound);
  if (consumers.length === 0) return;
  // Every consumer but the last gets a copy, made before the last sees `result`, so none can mutate another's.
  const result = resultOf(advertisement);
  const last = consumers.length - 1;
  for (let i = 0; i < consumers.length; i++)
    // An earlier callback may have stopped this scan.
    scans.get(consumers[i]!)?.onFound?.(i === last ? result : copyOf(result));
});

// Native times out quiet devices itself, so `onLost` fires even while JS timers are paused in the background.
setEventHandler('scanLost', (lost) => {
  for (const { scanId, deviceId } of lost)
    scans.get(scanId)?.onLost?.(deviceOf(deviceId));
});

setEventHandler('scanError', ({ error }) => {
  const failed = [...scans.values()];
  scans.clear();
  bindings().clearScans();
  // A `startScan()` between the failure and this event restarted the native scan; every scan ends here, so stop it.
  scheduleSetScan(null);
  const reason = errorOf(error);
  for (const options of failed) options.onError?.(reason);
});
