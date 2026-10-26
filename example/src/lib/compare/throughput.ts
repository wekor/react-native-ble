import * as Ble from '@wekor/react-native-ble';
import { type Characteristic, ConnectionPriority } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import { errorCode } from '@/lib/errors';
import { TestPeripheral } from '@/lib/test-peripheral';
import {
  characteristics,
  commands,
  parseSinkStats,
  SERVICE,
  sequenceOf,
  sinkPacket,
} from '@/lib/test-peripheral/protocol';
import { sleep, within } from '@/lib/wait';
import { plxConnect, plxManager, plxReady } from './libraries';
import { alternate, type Results, timeStep } from './suite';

/** What the throughput and latency steps need from a library. */
type Client = {
  name: 'ours' | 'plx';
  connect: () => Promise<void>;
  disconnect: () => Promise<unknown>;
  /** The largest value one write can carry. */
  maxWrite: (withoutResponse: boolean) => number;
  subscribe: (
    characteristic: string,
    onValue: (value: Uint8Array) => void
  ) => () => void;
  write: (
    characteristic: string,
    value: Uint8Array,
    withoutResponse: boolean
  ) => Promise<unknown>;
  read: (characteristic: string) => Promise<Uint8Array>;
};

const ours = (deviceId: string): Client => {
  const device = Ble.getDevice(deviceId);
  const service = SERVICE;
  return {
    name: 'ours',
    // On Android the fastest connection interval, as plx gets; iOS chooses for itself.
    connect: () => device.connect({ android: { priority: 'high' } }),
    disconnect: () => device.disconnect(),
    maxWrite: (withoutResponse) => device.maxWriteLength({ withoutResponse }),
    subscribe: (characteristic, onValue) =>
      device.subscribe(characteristic, onValue, { service }),
    write: (characteristic, value, withoutResponse) =>
      device.write(characteristic, value, { service, withoutResponse }),
    read: (characteristic) => device.read(characteristic, { service }),
  };
};

const fromBase64 = (value: string | null) =>
  Uint8Array.from(atob(value ?? ''), (char) => char.charCodeAt(0));

const toBase64 = (value: Uint8Array) => {
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text);
};

/** plx moves base64 strings, so its side decodes and encodes the way an app has to. */
const plx = (deviceId: string): Client => {
  const m = plxManager();
  let mtu = 23;
  return {
    name: 'plx',
    connect: async () => {
      await plxReady(m);
      const device = await plxConnect(m, deviceId);
      if (Platform.OS === 'android')
        await m.requestConnectionPriorityForDevice(
          deviceId,
          ConnectionPriority.High
        );
      mtu = device.mtu;
    },
    disconnect: () => m.cancelDeviceConnection(deviceId),
    // plx has no such call; an attribute value holds at most 512 bytes, which Android enforces.
    maxWrite: (withoutResponse) =>
      withoutResponse ? Math.min(mtu - 3, 512) : 512,
    subscribe: (characteristic, onValue) => {
      const subscription = m.monitorCharacteristicForDevice(
        deviceId,
        SERVICE,
        characteristic,
        (error, value: Characteristic | null) => {
          if (!error && value) onValue(fromBase64(value.value));
        }
      );
      return () => subscription.remove();
    },
    write: (characteristic, value, withoutResponse) =>
      withoutResponse
        ? m.writeCharacteristicWithoutResponseForDevice(
            deviceId,
            SERVICE,
            characteristic,
            toBase64(value)
          )
        : m.writeCharacteristicWithResponseForDevice(
            deviceId,
            SERVICE,
            characteristic,
            toBase64(value)
          ),
    read: async (characteristic) =>
      fromBase64(
        (await m.readCharacteristicForDevice(deviceId, SERVICE, characteristic))
          .value
      ),
  };
};

const kbps = (bytes: number, ms: number) =>
  `${(bytes / 1024 / (ms / 1000)).toFixed(1)} KB/s`;

/** `countTurns: false` leaves the JS thread alone, for measuring CPU time from outside the app. */
export const throughputOptions = { countTurns: true };

/**
 * How often the JS thread got to run a zero-delay timer while `work` ran: a busy thread gets fewer turns, so the
 * count stands for the JS time a library leaves to the app. The timer loop costs CPU itself.
 */
const withTurnCount = async <T>(work: () => Promise<T>) => {
  if (!throughputOptions.countTurns) return { result: await work(), turns: 0 };
  let turns = 0;
  let running = true;
  const spin = () => {
    if (!running) return;
    turns++;
    setTimeout(spin, 0);
  };
  spin();
  try {
    return { result: await work(), turns };
  } finally {
    running = false;
  }
};

const NOTIFICATIONS = 1000;
const WRITES = 2000;
const ACKED_WRITES = 200;

/** Streams `NOTIFICATIONS` from the peripheral and counts what arrives, in order or not. */
const notificationsIn = async (client: Client) => {
  let received = 0;
  let bytes = 0;
  let outOfOrder = 0;
  let expected = 0;
  let done: () => void = () => {};
  const all = new Promise<void>((resolve) => {
    done = resolve;
  });
  const off = client.subscribe(characteristics.stream, (value) => {
    if (sequenceOf(value) !== expected) outOfOrder++;
    expected = sequenceOf(value) + 1;
    received++;
    bytes += value.length;
    if (received === NOTIFICATIONS) done();
  });
  // The subscription is enabled before the start command, which queues behind it.
  const start = commands.notify(NOTIFICATIONS, 512);
  const { result: elapsed, turns } = await withTurnCount(async () => {
    const started = Date.now();
    await client.write(characteristics.control, start, false);
    await Promise.race([all, sleep(60_000)]);
    return Date.now() - started;
  });
  off();
  const lost = NOTIFICATIONS - received;
  return `${kbps(bytes, elapsed)} · ${received} in ${elapsed} ms · ${bytes / Math.max(received, 1)} B each · lost ${lost} · out of order ${outOfOrder} · JS turns ${turns}`;
};

const steps: [string, (client: Client) => Promise<string>][] = [
  [`${NOTIFICATIONS} notifications in`, notificationsIn],
  [
    `${WRITES} writes without response out`,
    async (client) => {
      await client.write(characteristics.control, commands.resetSink(), false);
      const size = client.maxWrite(true);
      const { result: elapsed, turns } = await withTurnCount(async () => {
        const started = Date.now();
        await Promise.all(
          Array.from({ length: WRITES }, (_, i) =>
            client.write(characteristics.sink, sinkPacket(i, size), true)
          )
        );
        return Date.now() - started;
      });
      // A write with response queues behind the others, so the peripheral has them all once it answers.
      await client.write(characteristics.sinkAck, sinkPacket(WRITES, 4), false);
      const stats = parseSinkStats(await client.read(characteristics.control));
      const arrived = stats.packets - 1;
      return `${kbps(WRITES * size, elapsed)} · ${size} B each · arrived ${arrived}/${WRITES} · out of order ${stats.outOfOrder} · peripheral saw ${stats.spanMs} ms · JS turns ${turns}`;
    },
  ],
  [
    `${ACKED_WRITES} writes with response out`,
    async (client) => {
      await client.write(characteristics.control, commands.resetSink(), false);
      const size = 512;
      const started = Date.now();
      for (let i = 0; i < ACKED_WRITES; i++)
        await client.write(characteristics.sinkAck, sinkPacket(i, size), false);
      const elapsed = Date.now() - started;
      return `${kbps(ACKED_WRITES * size, elapsed)} · ${(elapsed / ACKED_WRITES).toFixed(1)} ms each`;
    },
  ],
];

const L2CAP_BYTES = 1024 * 1024;
/** How long `L2CAP_BYTES` may take: about a minute at iOS's 18 KB/s to a Mac, so this only catches a stall. */
const L2CAP_TIMEOUT_MS = 180_000;
/** A size an app might send a file in; a write of any length works too. */
const L2CAP_CHUNK = 4096;

/** Sends `L2CAP_BYTES` to a channel that discards them and answers once it has them all. */
const l2capOut =
  (write: (channel: Ble.L2capChannel, data: Uint8Array) => Promise<unknown>) =>
  async (peripheral: TestPeripheral) => {
    await peripheral.discardOnNextChannel(L2CAP_BYTES);
    const channel = await peripheral.openChannel();
    try {
      const answered = new Promise<void>((resolve) =>
        channel.onData(() => resolve())
      );
      const data = new Uint8Array(L2CAP_BYTES);
      const { result: elapsed, turns } = await withTurnCount(async () => {
        const started = Date.now();
        await write(channel, data);
        await within(
          answered,
          L2CAP_TIMEOUT_MS,
          'the peripheral to have every byte'
        );
        return Date.now() - started;
      });
      return `${kbps(L2CAP_BYTES, elapsed)} · ${elapsed} ms · JS turns ${turns}`;
    } finally {
      await channel.close();
    }
  };

const l2capSteps: [string, (peripheral: TestPeripheral) => Promise<string>][] =
  [
    [
      'L2CAP 1 MB in',
      async (peripheral) => {
        await peripheral.greetOnNextChannel(L2CAP_BYTES);
        let bytes = 0;
        let chunks = 0;
        let done: () => void = () => {};
        const all = new Promise<void>((resolve) => {
          done = resolve;
        });
        // From the open, since the peripheral sends as soon as the channel is up.
        const started = Date.now();
        const channel = await peripheral.openChannel();
        try {
          const { result: elapsed, turns } = await withTurnCount(async () => {
            channel.onData((value) => {
              bytes += value.length;
              chunks++;
              if (bytes >= L2CAP_BYTES) done();
            });
            await within(all, L2CAP_TIMEOUT_MS, `${L2CAP_BYTES} bytes`);
            return Date.now() - started;
          });
          return `${kbps(bytes, elapsed)} · ${elapsed} ms · ${chunks} chunks of ${Math.round(bytes / chunks)} B · JS turns ${turns}`;
        } finally {
          await channel.close();
        }
      },
    ],
    [
      'L2CAP 1 MB out, one write',
      l2capOut((channel, data) => channel.write(data)),
    ],
    [
      `L2CAP 1 MB out, ${L2CAP_CHUNK / 1024} KB writes`,
      l2capOut((channel, data) =>
        Promise.all(
          Array.from({ length: data.length / L2CAP_CHUNK }, (_, i) =>
            channel.write(data.subarray(i * L2CAP_CHUNK, (i + 1) * L2CAP_CHUNK))
          )
        )
      ),
    ],
  ];

/** Runs one step, recording its result and its place and CPU time in the timeline. */
const runStep = async (
  lib: Client['name'],
  name: string,
  step: () => Promise<string>,
  results: Results
) => {
  results[name] = await timeStep(lib, name, () =>
    step().catch((error) => `✗ ${errorCode(error)}`)
  );
};

const runClient = async (
  client: Client,
  clientSteps: [string, (client: Client) => Promise<string>][]
) => {
  const results: Results = {};
  await client.disconnect().catch(() => {});
  await client.connect();
  for (const [name, step] of clientSteps)
    await runStep(client.name, name, () => step(client), results);
  await client.disconnect().catch(() => {});
  return results;
};

/**
 * L2CAP against the test peripheral, after the GATT steps on the same connection for reference. Ours only:
 * react-native-ble-plx has no L2CAP.
 */
export const l2capThroughput = async (deviceId: string) => {
  const client = ours(deviceId);
  const peripheral = TestPeripheral.fromId(deviceId);
  const results: Results = {};
  await client.disconnect().catch(() => {});
  await client.connect();
  for (const [name, step] of steps)
    await runStep(client.name, name, () => step(client), results);
  for (const [name, step] of l2capSteps)
    await runStep(client.name, name, () => step(peripheral), results);
  await client.disconnect().catch(() => {});
  return [{ lib: client.name, results }];
};

/** Throughput against the test peripheral `deviceId`, notifications in and writes out, for ours and plx alternately. */
export const throughput = (deviceId: string, rounds = 2) =>
  alternate(rounds, (lib) =>
    runClient((lib === 'ours' ? ours : plx)(deviceId), steps)
  );

const PINGS = 200;
/** How long a ping may take before it counts as lost: far beyond any connection interval. */
const PING_TIMEOUT_MS = 1_000;

/**
 * A JS thread as busy as one that renders: in each 16 ms frame it spends 8 ms on work. The library's own JS time
 * per event decides how long events wait behind it.
 */
const FRAME_MS = 16;
const FRAME_WORK_MS = 8;

const withJsLoad = async <T>(work: () => Promise<T>) => {
  let running = true;
  const frame = () => {
    if (!running) return;
    const end = performance.now() + FRAME_WORK_MS;
    while (performance.now() < end) {}
    setTimeout(frame, FRAME_MS - FRAME_WORK_MS);
  };
  frame();
  try {
    return await work();
  } finally {
    running = false;
  }
};

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;

/**
 * Round trips one at a time: a 20-byte write without response that the peripheral notifies straight back. Each
 * trip crosses the radio twice and the library twice, so the radio's share is the same for both libraries.
 */
const pings = async (client: Client) => {
  let waiting: { sequence: number; arrived: () => void } | undefined;
  const off = client.subscribe(characteristics.ping, (value) => {
    if (waiting && sequenceOf(value) === waiting.sequence) waiting.arrived();
  });
  let failedWrites = 0;
  const ping = (sequence: number) =>
    new Promise<number | undefined>((resolve) => {
      const started = performance.now();
      const timer = setTimeout(() => resolve(undefined), PING_TIMEOUT_MS);
      waiting = {
        sequence,
        arrived: () => {
          clearTimeout(timer);
          resolve(performance.now() - started);
        },
      };
      // A ping that never went out is lost too, at once.
      client
        .write(characteristics.ping, sinkPacket(sequence, 20), true)
        .catch(() => {
          failedWrites++;
          clearTimeout(timer);
          resolve(undefined);
        });
    });
  try {
    // Until one comes back, the subscription is still being enabled.
    let warm = false;
    for (let i = 0; i < 20 && !warm; i++)
      warm = (await ping(PINGS + i)) !== undefined;
    if (!warm) return '✗ no ping came back';
    const times: number[] = [];
    for (let i = 0; i < PINGS; i++) {
      const time = await ping(i);
      if (time !== undefined) times.push(time);
    }
    times.sort((a, b) => a - b);
    const ms = (p: number) => percentile(times, p).toFixed(1);
    return `median ${ms(0.5)} ms · p90 ${ms(0.9)} ms · p99 ${ms(0.99)} ms · lost ${PINGS - times.length}${failedWrites ? ` (${failedWrites} writes failed)` : ''}`;
  } finally {
    off();
  }
};

const latencySteps: [string, (client: Client) => Promise<string>][] = [
  [`${PINGS} pings, round trip`, pings],
  [
    `${PINGS} pings, round trip, JS busy`,
    (client) => withJsLoad(() => pings(client)),
  ],
  [
    `${NOTIFICATIONS} notifications in, JS busy`,
    (client) => withJsLoad(() => notificationsIn(client)),
  ],
];

/** Round-trip latency, idle and with a busy JS thread, for ours and plx alternately. */
export const latency = (deviceId: string, rounds = 2) =>
  alternate(rounds, (lib) =>
    runClient((lib === 'ours' ? ours : plx)(deviceId), latencySteps)
  );
