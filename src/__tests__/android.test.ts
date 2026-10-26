import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  answer,
  calls,
  callsOf,
  connectedDevice,
  emit,
  platform,
  services,
  settle,
} from './native';

const { configure } = await import('../index');

beforeAll(() => {
  platform.OS = 'android';
});

afterAll(() => {
  platform.OS = 'ios';
});

beforeEach(() => {
  calls.length = 0;
});

const connectedAndroid = async () => {
  const device = await connectedDevice();
  const android = device.android;
  if (!android) throw new Error('No Android members');
  return { device, android };
};

/** The `timeout` argument each Android operation passed to native. */
const timeouts = () => ({
  requestMtu: callsOf('requestMtu').map((call) => call.args[3]),
  setPhy: callsOf('setPhy').map((call) => call.args[3]),
  readPhy: callsOf('readPhy').map((call) => call.args[2]),
  refreshCache: callsOf('refreshCache').map((call) => call.args[2]),
});

test('Android operations pass their timeout to native: the default, the configured one, or their own', async () => {
  const { android } = await connectedAndroid();
  const all = (timeout?: number) => {
    const options = timeout === undefined ? undefined : { timeout };
    android.requestMtu(247, options);
    android.setPhy({ tx: ['le2m'] }, options);
    android.readPhy(options);
    android.refreshCache(options);
  };
  all();
  configure({ timeouts: { operation: 1000 } });
  all();
  configure({ timeouts: { operation: 30_000 } });
  all(5000);
  const expected = [30_000, 1000, 5000];
  expect(timeouts()).toEqual({
    requestMtu: expected,
    setPhy: expected,
    readPhy: expected,
    refreshCache: expected,
  });
});

test('a requestMtu result followed by a disconnect in the same batch leaves the default MTU', async () => {
  const { device, android } = await connectedAndroid();
  const requesting = android.requestMtu(247);
  answer(callsOf('requestMtu')[0], 247);
  emit('disconnected', { deviceId: device.id });
  expect(await requesting).toBe(247);
  expect(device.mtu).toBe(23);
});

test('a refreshCache result followed by a disconnect in the same batch leaves no services', async () => {
  const { device, android } = await connectedAndroid();
  const refreshing = android.refreshCache();
  answer(callsOf('refreshCache')[0], { mtu: 247, services });
  emit('disconnected', { deviceId: device.id });
  await refreshing;
  await settle();
  expect(device.state).toBe('disconnected');
  expect(device.services).toEqual([]);
  expect(device.mtu).toBe(23);
});

test('refreshCache takes over the MTU and services it reports', async () => {
  const { device, android } = await connectedAndroid();
  const refreshing = android.refreshCache();
  answer(callsOf('refreshCache')[0], { mtu: 247, services: [] });
  await refreshing;
  expect(device.mtu).toBe(247);
  expect(device.services).toEqual([]);
  expect(device.state).toBe('connected');
});
