import {
  getBluetoothState,
  getPermission,
  startScan,
} from '@wekor/react-native-ble';
import { ScanMode } from 'react-native-ble-plx';
import { sleep } from '@/lib/wait';
import { plxManager, plxReady } from './libraries';
import { alternate, type Results, timeStep } from './suite';

/** What a scan delivered in its window: devices, and the callbacks it took to deliver them. */
type Counts = { devices: Set<string>; callbacks: number; errors: string[] };

const counts = (): Counts => ({ devices: new Set(), callbacks: 0, errors: [] });
const describe = ({ devices, callbacks, errors }: Counts) =>
  `${devices.size} devices, ${callbacks} callbacks${errors.length ? `, errors: ${errors.join(', ')}` : ''}`;

/** Scans with each library's defaults for `ms`, counting what reaches JS. */
const ours = async (ms: number): Promise<Results> => {
  // What the scans start from: a scan can only run once Bluetooth is on and allowed.
  const before = `Bluetooth ${getBluetoothState()}, permission ${(await getPermission()).status}`;
  const one = await timeStep('ours', 'one scan', async () => {
    const seen = counts();
    const stop = startScan({
      onFound: (result) => {
        seen.callbacks++;
        seen.devices.add(result.device.id);
      },
      onError: (error) => seen.errors.push(error.code),
    });
    await sleep(ms);
    stop();
    return describe(seen);
  });
  // Two scans at once, as when a list scans while other code looks for a known device: the second joins late.
  const two = await timeStep('ours', 'two scans', async () => {
    const first = counts();
    const second = counts();
    const listen = (seen: Counts) =>
      startScan({
        onFound: (result) => {
          seen.callbacks++;
          seen.devices.add(result.device.id);
        },
        onError: (error) => seen.errors.push(error.code),
      });
    const stopFirst = listen(first);
    await sleep(ms / 4);
    const stopSecond = listen(second);
    await sleep((ms * 3) / 4);
    stopFirst();
    stopSecond();
    return `${describe(first)} · ${describe(second)}`;
  });
  return { 'starts from': before, 'one scan': one, 'two scans': two };
};

/** plx in the mode ours uses in the foreground; its own default, low power, hears far fewer advertisements. */
const plx = async (ms: number): Promise<Results> => {
  const manager = plxManager();
  await plxReady(manager);
  const one = await timeStep('plx', 'one scan', async () => {
    const seen = counts();
    await manager.startDeviceScan(
      null,
      { allowDuplicates: false, scanMode: ScanMode.LowLatency },
      (error, device) => {
        if (error) seen.errors.push(String(error.errorCode));
        if (!device) return;
        seen.callbacks++;
        seen.devices.add(device.id);
      }
    );
    await sleep(ms);
    await manager.stopDeviceScan();
    return describe(seen);
  });
  return {
    'one scan': one,
    'two scans': 'not supported: a second scan replaces the first',
  };
};

/**
 * Scanning with each library: one scan, then (ours only) two at once, each library going first once per two rounds.
 * Counts what reaches JS and, through the timeline, the CPU each step used.
 */
export const scanning = (ms = 20_000, rounds = 2) =>
  alternate(rounds, (lib) => (lib === 'ours' ? ours : plx)(ms));
