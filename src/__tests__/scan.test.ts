import { beforeEach, expect, test } from 'bun:test';
import type { ScanResult } from '../index';
import {
  calls,
  callsOf,
  emit,
  SERVICE,
  scanIds,
  scanSpecs,
  settle,
} from './native';

const { startScan } = await import('../index');

beforeEach(() => {
  calls.length = 0;
});

test('scans started and stopped in one JS task reach native once, as the final state', async () => {
  for (let i = 0; i < 10; i++) startScan({ onFound: () => {} })();
  const stop = startScan({ onFound: () => {} });
  await settle();
  expect(callsOf('setScan')).toHaveLength(1);
  expect(callsOf('setScan')[0]?.args[0]).not.toBeNull();
  stop();
  await settle();
  expect(callsOf('setScan').at(-1)?.args[0]).toBeNull();
});

test('a scan error ends every scan and stops the native scan, even one started meanwhile', async () => {
  const errors: string[] = [];
  startScan({
    onFound: () => {},
    onError: (error) => errors.push(error.code),
  });
  await settle();
  emit('scanError', { error: { code: 'bluetooth-off', message: 'off' } });
  await settle();
  expect(errors).toEqual(['bluetooth-off']);
  expect(callsOf('setScan').at(-1)?.args[0]).toBeNull();
});

const advertisement = (deviceId: string) => ({
  deviceId,
  rssi: -60,
  manufacturerData: new Uint8Array([0x4c, 0x00, 1]),
  serviceData: { [SERVICE]: new Uint8Array([2]) },
  serviceUuids: [SERVICE],
});

test('found and lost devices reach the scans native names, each with its own copy', async () => {
  const results: ScanResult[] = [];
  const lost: string[] = [];
  const stopPresence = startScan({
    onFound: (result) => {
      results.push(result);
      result.serviceUuids.push('changed');
      if (result.manufacturerData) result.manufacturerData[2] = 9;
    },
    onLost: (device) => lost.push(device.id),
  });
  const stopPlain = startScan({ onFound: (result) => results.push(result) });
  const [presence, plain] = scanIds.slice(-2);
  emit('scan', {
    scanIds: [presence, plain],
    advertisement: advertisement('scanned'),
  });
  expect(results.map((result) => result.device.id)).toEqual([
    'scanned',
    'scanned',
  ]);
  expect(results[0]?.device).toBe(results[1]?.device);
  expect(results[1]?.manufacturerData).toEqual(new Uint8Array([0x4c, 0, 1]));
  expect(results[1]?.serviceUuids).toEqual([SERVICE]);
  expect(results[0]?.serviceData[SERVICE]).not.toBe(
    results[1]?.serviceData[SERVICE]
  );

  emit('scanLost', [
    { scanId: presence, deviceId: 'scanned' },
    { scanId: plain, deviceId: 'scanned' },
  ]);
  expect(lost).toEqual(['scanned']);
  stopPresence();
  stopPlain();
});

test('a scan restarted from onError after a scan error keeps scanning', async () => {
  const errors: string[] = [];
  const restarted: string[] = [];
  startScan({
    onFound: () => {},
    onError: (error) => {
      errors.push(error.code);
      startScan({ onFound: (result) => restarted.push(result.device.id) });
    },
  });
  await settle();
  emit('scanError', { error: { code: 'scan-failed', message: 'failed' } });
  await settle();
  expect(errors).toEqual(['scan-failed']);
  expect(callsOf('setScan').at(-1)?.args[0]).not.toBeNull();
  emit('scan', {
    scanIds: [scanIds.at(-1)],
    advertisement: advertisement('again'),
  });
  expect(restarted).toEqual(['again']);
});

test('only a scan with onLost tracks presence', () => {
  startScan({ onFound: () => {} })();
  startScan({ onFound: () => {}, onLost: () => {} })();
  expect(scanSpecs.slice(-2).map((spec) => spec.tracksPresence)).toEqual([
    false,
    true,
  ]);
});
