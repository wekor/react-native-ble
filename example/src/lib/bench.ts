import { getBluetoothState, getPermission } from '@wekor/react-native-ble';
import { File, Paths } from 'expo-file-system';
import { cpuMs } from '../../modules/cpu-time';
import { run as runCompare } from '@/lib/compare';
import { TestPeripheral } from '@/lib/test-peripheral';
import { plxManager, plxReady } from '@/lib/compare/libraries';
import { scanning } from '@/lib/compare/scanning';
import {
  alternate,
  cpuClock,
  type Results,
  timeline,
  timeStep,
} from '@/lib/compare/suite';
import {
  l2capThroughput,
  latency,
  throughput,
  throughputOptions,
} from '@/lib/compare/throughput';
import { runTests } from '@/lib/test-peripheral/tests';
import { sleep } from '@/lib/wait';

/**
 * The library's own cost, without the radio, next to plx's: every operation's result travels the path
 * `getPermission()` takes (a JSI call into native, the native thread, an event through C++ back to JS).
 */
const bridge = async (rounds = 2) => {
  const count = 1000;
  const each = (ms: number, n = count) => `${((ms * 1000) / n).toFixed(1)} µs`;
  const time = async (work: () => unknown, n = count) => {
    const started = performance.now();
    for (let i = 0; i < n; i++) await work();
    return each(performance.now() - started, n);
  };
  const parallel = async (work: () => Promise<unknown>) => {
    const started = performance.now();
    await Promise.all(Array.from({ length: count }, work));
    return each(performance.now() - started);
  };
  const m = plxManager();
  await plxReady(m);
  // Warm both paths up first.
  for (let i = 0; i < 100; i++) {
    getBluetoothState();
    await m.state();
  }
  const value = new Uint8Array(512);
  const putBytes = globalThis.__ReactNativeBleBindings?.putBytes;
  // A native round trip is `getPermission()` for ours and `state()` for plx, which has no sync getter.
  const measure = async (lib: 'ours' | 'plx'): Promise<Results> =>
    lib === 'ours'
      ? {
          'sync getter (getBluetoothState)': await time(
            getBluetoothState,
            10_000
          ),
          'native round trip': await time(getPermission),
          'native round trip ×1000 in parallel': await parallel(getPermission),
          ...(putBytes
            ? {
                'putBytes(512 B) (bytes to native)': await time(
                  () => putBytes(value),
                  10_000
                ),
              }
            : {}),
        }
      : {
          'native round trip': await time(() => m.state()),
          'native round trip ×1000 in parallel': await parallel(() =>
            m.state()
          ),
        };
  return alternate(rounds, measure);
};

const report = (value: BenchResult) => {
  const text = JSON.stringify(value);
  // iOS release builds keep JS logs from the console: tooling pulls this file from the app's Documents instead.
  try {
    new File(Paths.document, 'bench-result.json').write(text);
  } catch (error) {
    console.warn('Could not write bench-result.json', error);
  }
  const size = 3000;
  const parts = Math.ceil(text.length / size);
  for (let i = 0; i < parts; i++)
    console.log(
      `BENCH ${i + 1}/${parts} ${text.slice(i * size, (i + 1) * size)}`
    );
};

export type BenchParams = {
  kind?: string;
  rounds?: string;
  id?: string;
  only?: string;
  turns?: string;
};

export type BenchResult = {
  kind?: string;
  started?: number;
  ended?: number;
  results?: unknown;
  timeline?: typeof timeline;
  error?: string;
};

/**
 * One measurement, for release builds, which have no debugger to drive them: the `bench` route runs it from
 * `bleexample://bench?kind=...`. `kind` is `bridge` (library cost without the radio), `scanning` (one and two scans
 * of nearby devices), `compare` (with `id`, the suite against that device), `throughput` (against the test
 * peripheral), `latency` (round trips against it, idle and with a busy JS thread), `l2cap` (L2CAP next to GATT
 * against it, ours only) or `tests` (its test suite; `only` picks tests). It first measures 10 s of idle CPU, to tell
 * the libraries' cost from the app's. The results and the step timeline go to Documents/bench-result.json and to the
 * log as `BENCH <part>/<parts> <json>` lines, for tooling to reassemble and to split a CPU profile by step.
 */
export const runBench = async (params: BenchParams): Promise<BenchResult> => {
  const { kind } = params;
  // Unset keeps each comparison's own default, which lets each library go first once.
  const rounds =
    params.rounds === undefined ? undefined : Number(params.rounds);
  timeline.length = 0;
  // A result file from an earlier run must not pass for this one's.
  try {
    const previous = new File(Paths.document, 'bench-result.json');
    if (previous.exists) previous.delete();
  } catch {}
  throughputOptions.countTurns = params.turns !== '0';
  cpuClock.read = cpuMs;
  await timeStep('-', 'idle', () => sleep(10_000));
  const started = Date.now();
  let value: BenchResult;
  try {
    const results =
      kind === 'bridge'
        ? await bridge(rounds)
        : kind === 'scanning'
          ? await scanning(undefined, rounds)
          : kind === 'compare'
            ? await runCompare(
                params.id ?? (await TestPeripheral.find()).device.id,
                rounds
              )
            : kind === 'tests'
              ? await runTests({ only: params.only })
              : kind === 'l2cap'
                ? await l2capThroughput((await TestPeripheral.find()).device.id)
                : kind === 'latency'
                  ? await latency(
                      (await TestPeripheral.find()).device.id,
                      rounds
                    )
                  : await throughput(
                      (await TestPeripheral.find()).device.id,
                      rounds
                    );
    value = { kind, started, ended: Date.now(), results, timeline };
  } catch (error) {
    value = { kind, error: String(error) };
  }
  report(value);
  return value;
};

/**
 * The query of a link left in Documents/bench-request.txt before launch, taken once: a profiler that launches the
 * app itself can't pass a link, and opening one meanwhile would relaunch the app under it.
 */
export const takeBenchRequest = () => {
  try {
    const request = new File(Paths.document, 'bench-request.txt');
    if (!request.exists) return undefined;
    const url = request.textSync().trim();
    request.delete();
    return url.split('?')[1] ?? '';
  } catch (error) {
    console.warn('Could not read bench-request.txt', error);
    return undefined;
  }
};

type BenchTable = {
  columns: string[];
  rows: string[][];
  /** The app's CPU use while idle, in percent of one core: what every step's CPU figure includes. */
  idleCpu?: string;
};

const percent = (cpuMs: number, ms: number) =>
  ms > 0 ? `${((cpuMs / ms) * 100).toFixed(1)}%` : '–';

/**
 * A measurement as a table: one row per step with each library's result, and its CPU use in percent of one core
 * where the platform reports CPU time. Rounds of the same library join with " / ".
 */
export const summarize = ({
  results,
  timeline: steps = [],
}: BenchResult): BenchTable => {
  const idle = steps.find((step) => step.step === 'idle');
  const idleCpu =
    idle?.cpuMs === undefined
      ? undefined
      : percent(idle.cpuMs, idle.end - idle.start);
  if (!Array.isArray(results))
    return {
      columns: ['Measurement', 'Result'],
      rows: Object.entries((results ?? {}) as Record<string, unknown>).map(
        ([key, value]) => [key, String(value)]
      ),
      idleCpu,
    };
  const runs = results as { lib: string; results: Record<string, string> }[];
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.results)))];
  const valuesOf = (lib: string, name: string) =>
    runs
      .filter((run) => run.lib === lib && run.results[name] !== undefined)
      .map((run) => run.results[name])
      .join(' / ');
  const cpuOf = (lib: string, name: string) => {
    const matching = steps.filter(
      (step) =>
        step.lib === lib && step.step === name && step.cpuMs !== undefined
    );
    if (!matching.length) return '–';
    const cpu = matching.reduce((sum, step) => sum + (step.cpuMs ?? 0), 0);
    const ms = matching.reduce((sum, step) => sum + step.end - step.start, 0);
    return percent(cpu, ms);
  };
  return {
    columns: ['Step', 'Ours', 'ble-plx', 'Ours CPU', 'ble-plx CPU'],
    rows: names.map((name) => [
      name,
      valuesOf('ours', name),
      valuesOf('plx', name),
      cpuOf('ours', name),
      cpuOf('plx', name),
    ]),
    idleCpu,
  };
};
