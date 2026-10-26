import type { Device } from '@wekor/react-native-ble';
import { errorCode, tally } from '@/lib/errors';
import { sleep } from '@/lib/wait';
import { type Library, ours, plx, type Target } from './libraries';

export type Results = Record<string, string>;

/** When each step ran, by wall clock, so a profile taken outside the app can be split by step. */
export const timeline: {
  lib: string;
  step: string;
  start: number;
  end: number;
  /** The app process's CPU time during the step, where the platform reports it. */
  cpuMs?: number;
}[] = [];

/** The process's CPU time in ms; set by the bench runner where available. */
export const cpuClock: { read?: () => number } = {};

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * The same steps for each library against the same device. Radio-bound steps measure the phone and the device as
 * much as the library; the state() calls and the correctness checks measure the library alone.
 */
const steps: [string, (lib: Library) => Promise<string>][] = [
  [
    'connect + discover, median of 5',
    async (lib) => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = Date.now();
        await lib.connect();
        times.push(Date.now() - started);
        if (i < 4) {
          await lib.disconnect();
          await sleep(300);
        }
      }
      return `${median(times)} ms`;
    },
  ],
  [
    '50 sequential reads, each',
    async (lib) => {
      const started = Date.now();
      for (let i = 0; i < 50; i++) await lib.read();
      return `${((Date.now() - started) / 50).toFixed(1)} ms`;
    },
  ],
  [
    // A read takes at least one radio round trip: far under 50 of them means reads answered with another's value.
    '50 parallel reads, total',
    async (lib) => {
      const started = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, lib.read)
      );
      return `${Date.now() - started} ms (${tally(results)})`;
    },
  ],
  [
    '1000 state() calls, each',
    async (lib) => {
      const started = performance.now();
      for (let i = 0; i < 1000; i++) await lib.state();
      return `${(performance.now() - started).toFixed(0)} µs`;
    },
  ],
  [
    '100 subscribe/unsubscribe',
    async (lib) => {
      let errors = 0;
      for (let i = 0; i < 100; i++) {
        const off = lib.subscribe(() => errors++);
        if (i % 3) await sleep(0);
        off();
      }
      // Queued behind every enable and disable.
      await lib.read();
      return `${errors} error callbacks${(await lib.isConnected()) ? '' : ' · DISCONNECTED'}`;
    },
  ],
  [
    'disconnect with 30 queued',
    async (lib) => {
      const reads = Array.from({ length: 30 }, lib.read);
      const settled = await Promise.race([
        Promise.allSettled([...reads, lib.disconnect()]),
        sleep(15_000).then(() => 'stuck' as const),
      ]);
      if (settled === 'stuck') return 'STUCK: a promise never settled';
      return `${tally(settled.slice(0, 30))}; disconnect ${settled[30]?.status}`;
    },
  ],
  [
    'connect during disconnect',
    async (lib) => {
      await lib.connect();
      const [disconnected, connected] = await Promise.allSettled([
        lib.disconnect(),
        lib.connect(),
      ]);
      await sleep(500);
      const outcome =
        connected.status === 'fulfilled' ? 'ok' : errorCode(connected.reason);
      return `disconnect ${disconnected.status}, connect ${outcome}${(await lib.isConnected()) ? '' : ' · NOT CONNECTED'}`;
    },
  ],
  [
    'scan 5 s, results',
    async (lib) => {
      await lib.disconnect().catch(() => {});
      await sleep(500);
      let results = 0;
      const stop = lib.scan(() => results++);
      await sleep(5000);
      stop();
      return String(results);
    },
  ],
];

/** Runs `work` as step `step` of `lib`, recording its wall time and CPU time in `timeline`. */
export const timeStep = async <T>(
  lib: string,
  step: string,
  work: () => Promise<T>
) => {
  const start = Date.now();
  const cpuStart = cpuClock.read?.();
  try {
    return await work();
  } finally {
    const cpuEnd = cpuClock.read?.();
    timeline.push({
      lib,
      step,
      start,
      end: Date.now(),
      cpuMs:
        cpuStart === undefined || cpuEnd === undefined
          ? undefined
          : cpuEnd - cpuStart,
    });
  }
};

export const runSuite = async (lib: Library) => {
  const results: Results = {};
  await lib.ready();
  // Start from no connection, whichever library held it last.
  await lib.disconnect().catch(() => {});
  for (const [name, step] of steps)
    results[name] = await timeStep(lib.name, name, () =>
      Promise.race([step(lib), sleep(60_000).then(() => 'STUCK (60 s)')]).catch(
        (error) => `✗ ${errorCode(error)}`
      )
    );
  await lib.disconnect().catch(() => {});
  return results;
};

/** A characteristic both libraries can read and subscribe to, from a connected device. */
export const targetOf = (device: Device): Target => {
  const characteristics = device.services.flatMap(
    (service) => service.characteristics
  );
  const notifying = characteristics.find(
    ({ properties }) => properties.notify || properties.indicate
  );
  if (!notifying)
    throw new Error(
      'The comparison needs a characteristic with notify or indicate'
    );
  return {
    deviceId: device.id,
    service: notifying.service,
    characteristic: notifying.uuid,
    readable: notifying.properties.read,
  };
};

/** Runs `run` for ours and plx alternately, `rounds` times each, each going first once per two rounds. */
export const alternate = async (
  rounds: number,
  run: (lib: Library['name']) => Promise<Results>
) => {
  const runs: { lib: Library['name']; results: Results }[] = [];
  for (let round = 0; round < rounds; round++)
    for (const lib of round % 2
      ? (['plx', 'ours'] as const)
      : (['ours', 'plx'] as const))
      runs.push({ lib, results: await run(lib) });
  return runs;
};

/** Runs the suite for ours and plx alternately against `target`. */
export const compare = (target: Target, rounds = 2) =>
  alternate(rounds, (lib) => runSuite((lib === 'ours' ? ours : plx)(target)));
