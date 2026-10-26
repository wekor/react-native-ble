import { type BleError, isBleError, startScan } from '@wekor/react-native-ble';
import { errorCode, errorText } from '@/lib/errors';
import { sleep, waitFor, within } from '@/lib/wait';
import { TestPeripheral } from './index';
import { characteristics, SERVICE } from './protocol';

/** Thrown by a test that does not apply here; the runner reports it as skipped, with this reason. */
export class TestSkipped extends Error {}

const expect = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

/** The BleError `operation` fails with; throws if it succeeds. */
const failure = async (operation: Promise<unknown>) => {
  try {
    await operation;
  } catch (error) {
    return error as BleError;
  }
  throw new Error('Expected the operation to fail');
};

/** Counts sequence numbers as they arrive, and those out of order. */
const sequence = () => {
  const counts = { received: 0, outOfOrder: 0 };
  const add = (value: number) => {
    if (value !== counts.received) counts.outOfOrder++;
    counts.received++;
  };
  return { counts, add };
};

/**
 * How long a subscription waits before asking the peripheral to stream: macOS reports a subscriber some time after
 * it has answered the CCCD write, and the peripheral streams only to subscribers it has been told about.
 */
const SUBSCRIBE_SETTLE_MS = 300;

export type TestGroup =
  | 'GATT'
  | 'Notifications'
  | 'File transfer'
  | 'Connection'
  | 'L2CAP'
  | 'Scanning';

export type TestCase = {
  group: TestGroup;
  name: string;
  /** Runs on a connected peripheral; a string it returns is shown with the result. */
  run: (peripheral: TestPeripheral) => Promise<string | undefined>;
};

export const tests: TestCase[] = [
  {
    group: 'GATT',
    name: 'discovery',
    run: async ({ device }) => {
      const service = device.services.find(({ uuid }) => uuid === SERVICE);
      expect(!!service, 'Test service missing');
      const expected = Object.keys(characteristics).length - 1; // `extra` is in the extra service
      expect(
        service!.characteristics.length === expected,
        `${service!.characteristics.length} characteristics, expected ${expected}`
      );
      const pattern = service!.characteristics.find(
        ({ uuid }) => uuid === characteristics.pattern
      );
      expect(
        !!pattern?.descriptors.some(({ uuid }) => uuid.startsWith('00002901')),
        'PATTERN has no 2901 descriptor'
      );
      return `MTU ${device.mtu}, max write ${device.maxWriteLength()} / ${device.maxWriteLength({ withoutResponse: true })}`;
    },
  },
  {
    group: 'GATT',
    name: 'long read',
    run: async (peripheral) => {
      const value = await peripheral.readPattern();
      expect(value.length === 512, `${value.length} bytes, expected 512`);
      expect(
        value.every((byte, i) => byte === (i & 0xff)),
        'Wrong bytes'
      );
      return undefined;
    },
  },
  {
    group: 'GATT',
    name: 'parallel reads run in order',
    run: async (peripheral) => {
      const values = await Promise.all(
        Array.from({ length: 20 }, () => peripheral.readCounter())
      );
      expect(
        values.every((value, i) => i === 0 || value === values[i - 1]! + 1),
        `Values ${values.join(', ')}`
      );
      return undefined;
    },
  },
  {
    group: 'GATT',
    name: 'long write and read back',
    run: async (peripheral) => {
      const length = peripheral.device.maxWriteLength();
      const value = new Uint8Array(length).map((_, i) => (i * 7) & 0xff);
      await peripheral.writeEcho(value);
      const back = await peripheral.readEcho();
      expect(
        back.length === length && back.every((byte, i) => byte === value[i]),
        `Read back ${back.length} of ${length} bytes, or different ones`
      );
      return `${length} bytes`;
    },
  },
  {
    group: 'GATT',
    name: 'descriptor read',
    run: async (peripheral) => {
      const description = await peripheral.readPatternDescription();
      expect(description === 'Pattern', `Got "${description}"`);
      return undefined;
    },
  },
  {
    group: 'GATT',
    name: 'ATT error reaches JS as gatt',
    run: async (peripheral) => {
      const error = await failure(peripheral.readError());
      expect(error.code === 'gatt', `Code ${errorCode(error)}`);
      // The link stays up and the queue moves on.
      await peripheral.readCounter();
      return `nativeCode ${error.nativeCode}`;
    },
  },
  {
    group: 'GATT',
    name: 'writes without response in order',
    run: async (peripheral) => {
      const count = 1000;
      const size = peripheral.device.maxWriteLength({ withoutResponse: true });
      await peripheral.resetSink();
      await Promise.all(
        Array.from({ length: count }, (_, i) => peripheral.writeSink(i, size))
      );
      // The read goes out after every write, so the statistics count them all.
      // Android can report a request right after a burst failed with 143 (connection congested), though it sent
      // it; reading the statistics again is harmless.
      const stats = await peripheral
        .readSinkStats()
        .catch((error) =>
          isBleError(error, 'gatt') && error.nativeCode === 143
            ? peripheral.readSinkStats()
            : Promise.reject(error)
        );
      expect(stats.packets === count, `${stats.packets} of ${count} arrived`);
      expect(stats.outOfOrder === 0, `${stats.outOfOrder} out of order`);
      return `${count} × ${size} B in ${stats.spanMs} ms`;
    },
  },
  {
    group: 'Notifications',
    name: 'notifications in order',
    run: async (peripheral) => {
      const count = 2000;
      const { counts, add } = sequence();
      const errors: string[] = [];
      const unsubscribe = peripheral.onNotification(add, (error) =>
        errors.push(error.code)
      );
      try {
        await sleep(SUBSCRIBE_SETTLE_MS);
        const started = Date.now();
        await peripheral.startNotifications(count, 180);
        await waitFor(
          `${count} notifications`,
          () => counts.received >= count,
          60_000
        );
        expect(counts.outOfOrder === 0, `${counts.outOfOrder} out of order`);
        expect(!errors.length, `Errors ${errors.join(', ')}`);
        return `${count} in ${Date.now() - started} ms`;
      } finally {
        unsubscribe();
      }
    },
  },
  {
    group: 'Notifications',
    name: 'indications',
    run: async (peripheral) => {
      const count = 50;
      const { counts, add } = sequence();
      const unsubscribe = peripheral.onIndication(add);
      try {
        await sleep(SUBSCRIBE_SETTLE_MS);
        await peripheral.startIndications(count, 20);
        await waitFor(
          `${count} indications`,
          () => counts.received >= count,
          20_000
        );
        expect(counts.outOfOrder === 0, `${counts.outOfOrder} out of order`);
        return undefined;
      } finally {
        unsubscribe();
      }
    },
  },
  {
    group: 'Notifications',
    name: 'subscribe churn',
    run: async (peripheral) => {
      const errors: string[] = [];
      for (let i = 0; i < 20; i++) {
        const stop = peripheral.onNotification(
          () => {},
          (error) => errors.push(error.code)
        );
        if (i % 2) await sleep(0);
        stop();
      }
      const { counts, add } = sequence();
      const unsubscribe = peripheral.onNotification(add, (error) =>
        errors.push(error.code)
      );
      try {
        await sleep(SUBSCRIBE_SETTLE_MS);
        await peripheral.startNotifications(10, 20);
        await waitFor('10 notifications', () => counts.received >= 10, 5_000);
        expect(!errors.length, `Errors ${errors.join(', ')}`);
        return undefined;
      } finally {
        unsubscribe();
      }
    },
  },
  {
    group: 'Notifications',
    name: 'services changed: rediscovery keeps subscriptions',
    run: async (peripheral) => {
      // Android subscribes to Service Changed only when pairing completes, so an unbonded device never tells it.
      if (
        peripheral.device.android &&
        peripheral.device.android.bondState !== 'bonded'
      )
        throw new TestSkipped(
          'Android tells only bonded devices about changed services'
        );
      const { counts, add } = sequence();
      const unsubscribe = peripheral.onNotification(add);
      try {
        await peripheral.addExtraService();
        await waitFor(
          'the extra service',
          () => peripheral.hasExtraService,
          15_000
        );
        const extra = await peripheral.readExtra();
        expect(extra === 'extra', `Extra reads "${extra}"`);
        await peripheral.startNotifications(10, 20);
        await waitFor('10 notifications', () => counts.received >= 10, 5_000);
        await peripheral.removeExtraService();
        await waitFor(
          'the extra service to go',
          () => !peripheral.hasExtraService,
          15_000
        );
        return undefined;
      } finally {
        unsubscribe();
        await peripheral.removeExtraService().catch(() => {});
      }
    },
  },
  {
    group: 'File transfer',
    name: '100 KB file arrives whole',
    run: async (peripheral) => {
      const file = new Uint8Array(100 * 1024).map((_, i) => (i * 31) & 0xff);
      const started = Date.now();
      await peripheral.sendFile(file);
      const ms = Date.now() - started;
      return `${(file.length / 1024 / (ms / 1000)).toFixed(1)} KB/s`;
    },
  },
  {
    group: 'Connection',
    name: 'late answer keeps the link',
    run: async (peripheral) => {
      // Late, but within twice the timeout: the library waits that long before it drops the link.
      await peripheral.setSlowDelay(1500);
      const error = await failure(peripheral.readSlow({ timeout: 1_000 }));
      expect(error.code === 'timeout', `Code ${errorCode(error)}`);
      // Runs once SLOW's late answer is in.
      await peripheral.readCounter();
      expect(
        peripheral.device.state === 'connected',
        `State ${peripheral.device.state}`
      );
      return undefined;
    },
  },
  {
    group: 'Connection',
    name: 'disconnect fails queued work',
    run: async (peripheral) => {
      await peripheral.setSlowDelay(1000);
      const reads = Array.from({ length: 5 }, () =>
        peripheral.readSlow().then(
          () => 'ok',
          (error) => errorCode(error)
        )
      );
      await sleep(100);
      await peripheral.device.disconnect();
      const outcomes = await Promise.all(reads);
      expect(
        outcomes.every((outcome) => outcome !== 'ok'),
        `Outcomes ${outcomes.join(', ')}`
      );
      return outcomes.join(', ');
    },
  },
  {
    group: 'Connection',
    name: 'connect during disconnect',
    run: async (peripheral) => {
      const [disconnected, connected] = await Promise.allSettled([
        peripheral.device.disconnect(),
        peripheral.device.connect(),
      ]);
      expect(
        connected.status === 'fulfilled',
        `Connect ${connected.status === 'rejected' ? errorCode(connected.reason) : ''}`
      );
      expect(
        peripheral.device.state === 'connected',
        `State ${peripheral.device.state}`
      );
      await peripheral.readCounter();
      return `disconnect ${disconnected.status}`;
    },
  },
  {
    group: 'Connection',
    name: 'unanswered op drops the link after a second timeout',
    run: async (peripheral) => {
      const disconnected = new Promise<BleError | undefined>((resolve) => {
        const stop = peripheral.device.onDisconnect((error) => {
          stop();
          resolve(error);
        });
      });
      const first = await failure(peripheral.readNever({ timeout: 1_000 }));
      expect(first.code === 'timeout', `First: ${errorCode(first)}`);
      // The first read's second timeout drops the link, which fails the read queued behind it.
      const second = await failure(peripheral.readCounter());
      expect(second.code === 'disconnected', `Second: ${errorCode(second)}`);
      const error = await within(disconnected, 5_000, 'the link to drop');
      return `disconnected: ${error?.code ?? 'no error'}`;
    },
  },
  {
    group: 'Connection',
    name: 'late subscribe answer keeps the link',
    run: async (peripheral) => {
      // A subscribe that times out but succeeds late is turned off again by an op with the same timeout. With the
      // timeout below one round trip but above half of it, that op times out once, which must not drop the link.
      // The answer can still come after twice the timeout on a slow link, where dropping is right, so a drop is
      // retried; a connection that drops on the first timeout drops every time.
      const outcomes: string[] = [];
      for (const share of [0.75, 0.75, 0.6, 0.6, 0.5]) {
        if (peripheral.device.state !== 'connected') await peripheral.connect();
        const trips: number[] = [];
        for (let i = 0; i < 5; i++) {
          const started = Date.now();
          await peripheral.readCounter();
          trips.push(Date.now() - started);
        }
        const timeout = Math.round(
          share * trips.sort((a, b) => a - b)[trips.length >> 1]!
        );
        let dropped = false;
        const stop = peripheral.onDisconnect(() => {
          dropped = true;
        });
        try {
          let error: BleError | undefined;
          const unsubscribe = peripheral.device.subscribe(
            characteristics.stream,
            () => {},
            {
              timeout,
              onError: (e) => {
                error = e;
              },
            }
          );
          await sleep(Math.max(1_000, timeout * 10));
          unsubscribe();
          if (dropped) {
            outcomes.push(`dropped at ${timeout} ms`);
            continue;
          }
          // Answered in time: the path under test did not run, so try a shorter timeout.
          if (error?.code !== 'timeout') {
            outcomes.push(`answered within ${timeout} ms`);
            continue;
          }
          await peripheral.readCounter();
          return `timeout ${timeout} ms${outcomes.length ? ` after ${outcomes.join(', ')}` : ''}`;
        } finally {
          stop();
        }
      }
      throw new Error(outcomes.join(', '));
    },
  },
  {
    group: 'Connection',
    name: '5 connect cycles',
    run: async (peripheral) => {
      for (let i = 0; i < 5; i++) {
        if (peripheral.device.state !== 'connected') await peripheral.connect();
        await peripheral.readCounter();
        await peripheral.disconnect();
      }
      expect(
        peripheral.device.state === 'disconnected',
        `State ${peripheral.device.state}`
      );
      return undefined;
    },
  },
  {
    group: 'L2CAP',
    name: 'L2CAP echo',
    run: async (peripheral) => {
      const channel = await peripheral.openChannel();
      try {
        const sent = new Uint8Array(2000).map((_, i) => (i * 13) & 0xff);
        const received: number[] = [];
        channel.onData((value) => received.push(...value));
        await channel.write(sent);
        await waitFor(
          `${sent.length} echoed bytes`,
          () => received.length >= sent.length,
          10_000
        );
        expect(
          received.every((byte, i) => byte === sent[i]),
          'The echo differs'
        );
        return `PSM ${channel.psm}`;
      } finally {
        await channel.close();
      }
    },
  },
  {
    group: 'L2CAP',
    name: 'L2CAP data sent as it opens',
    run: async (peripheral) => {
      const length = 20_000;
      await peripheral.greetOnNextChannel(length);
      const channel = await peripheral.openChannel();
      try {
        // Listening late, so what arrived before must wait for the first listener.
        await sleep(500);
        const received: number[] = [];
        channel.onData((value) => received.push(...value));
        await waitFor(
          `${length} bytes`,
          () => received.length >= length,
          10_000
        );
        expect(
          received.every((byte, i) => byte === (i & 0xff)),
          'The bytes differ'
        );
        return `${length} bytes`;
      } finally {
        await channel.close();
      }
    },
  },
  {
    group: 'L2CAP',
    name: 'L2CAP open ends with the link',
    run: async (peripheral) => {
      const psm = await peripheral.readPsm();
      // No timeout: only the disconnect can end the open.
      const opening = failure(
        peripheral.device.openL2capChannel(psm, { timeout: 0 })
      );
      await peripheral.disconnect();
      const error = await within(opening, 5_000, 'the open to end');
      expect(error.code === 'disconnected', `Code ${errorCode(error)}`);
      return undefined;
    },
  },
  {
    group: 'Scanning',
    name: 'presence: lost and found again',
    run: async (peripheral) => {
      const events: string[] = [];
      const stop = startScan({
        services: [SERVICE],
        lostAfter: 2_000,
        onFound: () => events.push('found'),
        onLost: () => events.push('lost'),
      });
      try {
        await waitFor('found', () => events.includes('found'), 10_000);
        await peripheral.pauseAdvertising(5_000);
        await peripheral.device.disconnect();
        await waitFor('lost', () => events.includes('lost'), 10_000);
        await waitFor(
          'found again',
          () => events.lastIndexOf('found') > events.indexOf('lost'),
          15_000
        );
        return events.join(' → ');
      } finally {
        stop();
      }
    },
  },
  {
    group: 'Scanning',
    name: '10 scan restarts',
    run: async (peripheral) => {
      await peripheral.disconnect();
      // Android allows five scan starts per 30 s; the library spaces the rest, so every scan still finds it.
      for (let i = 0; i < 10; i++) {
        let found = false;
        const stop = startScan({
          services: [SERVICE],
          onFound: () => {
            found = true;
          },
        });
        try {
          await waitFor(`scan ${i + 1} to find it`, () => found, 45_000);
        } finally {
          stop();
        }
      }
      return undefined;
    },
  },
];

export type TestResult = {
  /** The test did not apply here; `detail` says why. */
  skipped?: boolean;
  group: TestGroup;
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
};

export type RunOptions = {
  /** Runs only the tests whose name contains this. */
  only?: string;
  /** Runs only the test with exactly this name. */
  name?: string;
  onStart?: (name: string) => void;
  onResult?: (result: TestResult) => void;
};

/** Runs the tests in order against the test peripheral, connecting before each one as needed. */
export const runTests = async ({
  only,
  name,
  onStart,
  onResult,
}: RunOptions = {}) => {
  const peripheral = await TestPeripheral.find();
  const results: TestResult[] = [];
  for (const test of tests) {
    if (only && !test.name.includes(only)) continue;
    if (name && test.name !== name) continue;
    onStart?.(test.name);
    const started = Date.now();
    let ok = true;
    let skipped = false;
    let detail: string | undefined;
    try {
      if (peripheral.device.state !== 'connected')
        await peripheral.device.connect();
      detail = await test.run(peripheral);
    } catch (error) {
      skipped = error instanceof TestSkipped;
      ok = skipped;
      detail = errorText(error);
    }
    const result = {
      group: test.group,
      name: test.name,
      ok,
      skipped,
      ms: Date.now() - started,
      detail,
    };
    results.push(result);
    console.log(
      `${skipped ? '–' : ok ? '✓' : '✗'} ${test.name} (${result.ms} ms)${detail ? `: ${detail}` : ''}`
    );
    onResult?.(result);
  }
  await peripheral.device.disconnect().catch(() => {});
  return results;
};
