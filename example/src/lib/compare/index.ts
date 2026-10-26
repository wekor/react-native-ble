import { getDevice } from '@wekor/react-native-ble';
import { TestPeripheral } from '@/lib/test-peripheral';
import { ours, plx } from './libraries';
import { compare, runSuite, targetOf } from './suite';
import { throughput as runThroughput } from './throughput';

/** Connects once to find a characteristic both libraries can use. */
const findTarget = async (deviceId: string) => {
  const device = getDevice(deviceId);
  await device.connect();
  const target = targetOf(device);
  await device.disconnect();
  return target;
};

/** The comparison with react-native-ble-plx against `deviceId`, each library going first once per two rounds. */
export const run = async (deviceId: string, rounds = 2) =>
  compare(await findTarget(deviceId), rounds);

/** The comparison's suite for a single library. */
export const runOnly = async (deviceId: string, lib: 'ours' | 'plx') =>
  runSuite((lib === 'ours' ? ours : plx)(await findTarget(deviceId)));

/** Throughput against the test peripheral, ours and plx alternately. */
export const throughput = async (rounds = 2) =>
  runThroughput((await TestPeripheral.find()).device.id, rounds);
