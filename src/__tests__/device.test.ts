import { beforeEach, expect, test } from 'bun:test';
import {
  answer,
  CHARACTERISTIC,
  calls,
  callsOf,
  connectedDevice as connected,
  emit,
  answerError,
  rejection,
  returns,
  SERVICE,
  services,
  settle,
  thrownCode,
} from './native';

const { getDevice, isBleError } = await import('../index');

const notifyCalls = () => callsOf('setNotify').map((call) => call.args[4]);
const notification = (deviceId: string, value: number) =>
  emit('notification', {
    deviceId,
    service: SERVICE,
    characteristic: CHARACTERISTIC,
    value: new Uint8Array([value]),
  });

beforeEach(() => {
  calls.length = 0;
  for (const name of Object.keys(returns)) delete returns[name];
});

const code = async (promise: Promise<unknown>) => {
  const error = await rejection(promise);
  return isBleError(error) ? error.code : error;
};

const emitDisconnected = (deviceId: string) =>
  emit('disconnected', {
    deviceId,
    error: { code: 'disconnected', message: 'gone' },
  });

test('subscribe, unsubscribe and subscribe again while enabling keeps notifications on', async () => {
  // React StrictMode runs an effect, its cleanup and the effect again, all before the device answers.
  const device = await connected();
  const received: number[] = [];
  device.subscribe('2a37', (value) => received.push(value[0] ?? -1))();
  device.subscribe('2a37', (value) => received.push(value[0] ?? -1));
  expect(notifyCalls()).toEqual([true]);
  answer(callsOf('setNotify')[0]);
  await settle();
  expect(notifyCalls()).toEqual([true]);
  notification(device.id, 7);
  expect(received).toEqual([7]);
});

test('unsubscribing while enabling disables once the device answers', async () => {
  const device = await connected();
  device.subscribe('2a37', () => {})();
  answer(callsOf('setNotify')[0]);
  await settle();
  expect(notifyCalls()).toEqual([true, false]);
});

test('a failed enable ends the subscription with the error', async () => {
  const device = await connected();
  const errors: string[] = [];
  device.subscribe('2a37', () => {}, {
    onError: (error) => errors.push(error.code),
  });
  answerError(callsOf('setNotify')[0], 'gatt');
  await settle();
  expect(errors).toEqual(['gatt']);
});

test('a failed enable ends the subscription within its result, so a subscribe right after starts anew', async () => {
  const device = await connected();
  const errors: string[] = [];
  device.subscribe('2a37', () => {}, {
    onError: (error) => errors.push(error.code),
  });
  answerError(callsOf('setNotify')[0], 'gatt');
  // Same batch: the failed subscription is already gone.
  device.subscribe('2a37', () => {}, {
    onError: (error) => errors.push(`second ${error.code}`),
  });
  await settle();
  expect(errors).toEqual(['gatt']);
  expect(notifyCalls()).toEqual([true, true]);
});

test('an onError that throws still lets the enable settle', async () => {
  const device = await connected();
  device.subscribe('2a37', () => {}, {
    onError: () => {
      throw new Error('listener bug');
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    answerError(callsOf('setNotify')[0], 'gatt');
  } finally {
    console.error = original;
  }
  await settle();
  device.subscribe('2a37', () => {});
  expect(notifyCalls()).toEqual([true, true]);
});

test('a services change rediscovers, enables subscriptions again and ends vanished ones', async () => {
  const device = await connected();
  const received: number[] = [];
  const errors: string[] = [];
  device.subscribe('2a37', (value) => received.push(value[0] ?? -1), {
    onError: (error) => errors.push(error.code),
  });
  answer(callsOf('setNotify')[0]);
  await settle();

  emit('servicesChanged', { deviceId: device.id });
  answer(callsOf('rediscoverServices')[0], services);
  await settle();
  expect(notifyCalls()).toEqual([true, true]);
  answer(callsOf('setNotify')[1]);
  await settle();
  notification(device.id, 9);
  expect(received).toEqual([9]);

  emit('servicesChanged', { deviceId: device.id });
  answer(callsOf('rediscoverServices')[1], []);
  await settle();
  expect(errors).toEqual(['not-found']);
  expect(device.services).toEqual([]);
});

test('a failed rediscovery ends subscriptions with its error', async () => {
  const device = await connected();
  const errors: string[] = [];
  device.subscribe('2a37', () => {}, {
    onError: (error) => errors.push(error.code),
  });
  answer(callsOf('setNotify')[0]);
  await settle();
  emit('servicesChanged', { deviceId: device.id });
  answerError(callsOf('rediscoverServices')[0], 'timeout');
  // Within the result, before anything later in the batch.
  expect(errors).toEqual(['timeout']);
  expect(device.services).toEqual([]);
});

test('connect right after disconnect reaches native, which connects again once disconnected', async () => {
  const device = await connected();
  const disconnecting = device.disconnect();
  const connecting = device.connect();
  expect(callsOf('connect')).toHaveLength(1);
  answer(callsOf('disconnect')[0]);
  emit('disconnected', { deviceId: device.id });
  answer(callsOf('connect')[0], { mtu: 185, services });
  await Promise.all([disconnecting, connecting]);
  expect(device.state).toBe('connected');
});

test('a disconnect ends subscriptions without an error', async () => {
  const device = await connected();
  const errors: string[] = [];
  device.subscribe('2a37', () => {}, {
    onError: (error) => errors.push(error.code),
  });
  answerError(callsOf('setNotify')[0], 'disconnected');
  emit('disconnected', {
    deviceId: device.id,
    error: { code: 'disconnected', message: '' },
  });
  await settle();
  expect(errors).toEqual([]);
  expect(device.state).toBe('disconnected');
});

test('the same id gives the same device', () => {
  expect(getDevice('same')).toBe(getDevice('same'));
});

// Native delivers events in batches and promise continuations run after the batch, so these tests emit a result
// and the events following it synchronously, as one batch would.

test('a connect result followed by a disconnect in the same batch leaves the device disconnected', async () => {
  const device = getDevice('batch-connect');
  const reasons: (string | undefined)[] = [];
  const off = device.onDisconnect((error) => reasons.push(error?.code));
  const connecting = device.connect();
  answer(callsOf('connect').at(-1), { mtu: 185, services });
  emitDisconnected(device.id);
  await connecting;
  expect(device.state).toBe('disconnected');
  expect(device.services).toEqual([]);
  expect(device.mtu).toBe(23);
  expect(reasons).toEqual(['disconnected']);
  off();
});

test('a connect from the disconnect listener after a connect result in the same batch reaches native', async () => {
  const device = getDevice('batch-reconnect');
  let reconnecting: Promise<void> | undefined;
  const off = device.onDisconnect(() => {
    reconnecting = device.connect();
  });
  const connecting = device.connect();
  answer(callsOf('connect').at(-1), { mtu: 185, services });
  emitDisconnected(device.id);
  off();
  await connecting;
  expect(callsOf('connect')).toHaveLength(2);
  answer(callsOf('connect').at(-1), { mtu: 185, services });
  await reconnecting;
  expect(device.state).toBe('connected');
});

test('a rediscovery result followed by a disconnect in the same batch leaves no services', async () => {
  const device = await connected();
  emit('servicesChanged', { deviceId: device.id });
  answer(callsOf('rediscoverServices')[0], services);
  emitDisconnected(device.id);
  await settle();
  expect(device.state).toBe('disconnected');
  expect(device.services).toEqual([]);
  expect(device.mtu).toBe(23);
});

test('a read value reaches subscribers before a notification that followed it', async () => {
  const device = await connected();
  const received: number[] = [];
  device.subscribe('2a37', (value) => received.push(value[0] ?? -1));
  answer(callsOf('setNotify')[0]);
  await settle();
  const reading = device.read('2a37');
  answer(callsOf('read')[0], new Uint8Array([1]));
  notification(device.id, 2);
  expect(await reading).toEqual(new Uint8Array([1]));
  expect(received).toEqual([1, 2]);
});

test('a subscriber cannot change the value a read returns', async () => {
  const device = await connected();
  device.subscribe('2a37', (value) => {
    value[0] = 0;
  });
  answer(callsOf('setNotify')[0]);
  await settle();
  const reading = device.read('2a37');
  answer(callsOf('read')[0], new Uint8Array([1]));
  expect(await reading).toEqual(new Uint8Array([1]));
});

test('every subscriber gets its own copy of a value', async () => {
  const device = await connected();
  const values: Uint8Array[] = [];
  device.subscribe('2a37', (value) => {
    values.push(value);
    value[0] = 0;
  });
  device.subscribe('2a37', (value) => values.push(value));
  notification(device.id, 5);
  expect(values.map((value) => value[0])).toEqual([0, 5]);
});

test('connect, disconnect and connect in one go starts a second connect', async () => {
  const device = getDevice('reconnect');
  const first = device.connect();
  const disconnecting = device.disconnect();
  const second = device.connect();
  expect(second).not.toBe(first);
  expect(callsOf('connect')).toHaveLength(2);
  answerError(callsOf('connect')[0], 'cancelled');
  answer(callsOf('disconnect')[0]);
  answer(callsOf('connect')[1], { mtu: 185, services });
  expect(await code(first)).toBe('cancelled');
  await Promise.all([disconnecting, second]);
  expect(device.state).toBe('connected');
  expect(device.connect()).not.toBe(second);
});

test('a pending connect is shared, and connecting a connected device resolves at once', async () => {
  const device = getDevice('dedupe');
  const first = device.connect();
  expect(device.connect()).toBe(first);
  expect(callsOf('connect')).toHaveLength(1);
  answer(callsOf('connect')[0], { mtu: 185, services });
  await first;
  calls.length = 0;
  await device.connect();
  expect(calls).toEqual([]);
});

test('a services change enables subscriptions again with their timeout', async () => {
  const device = await connected();
  device.subscribe('2a37', () => {}, { timeout: 1234 });
  answer(callsOf('setNotify')[0]);
  await settle();
  emit('servicesChanged', { deviceId: device.id });
  answer(callsOf('rediscoverServices')[0], services);
  await settle();
  expect(callsOf('setNotify').map((call) => call.args[6])).toEqual([
    1234, 1234,
  ]);
});

test('a characteristic is located by UUID, service and property', async () => {
  const other = '0000180f-0000-1000-8000-00805f9b34fb';
  const twice = [...services, { ...services[0], uuid: other }];
  const device = await connected(twice);
  expect(await code(device.read('ffff'))).toBe('not-found');
  expect(await code(device.read('2a37', { service: '1800' }))).toBe(
    'not-found'
  );
  expect(await code(device.read('2a37'))).toBe('ambiguous');
  expect(
    await code(
      device.write('2a37', new Uint8Array([1]), {
        service: '180d',
        withoutResponse: true,
      })
    )
  ).toBe('not-permitted');
  expect(
    thrownCode(() =>
      device.subscribe('2a37', () => {}, { mode: 'indicate', service: other })
    )
  ).toBe('not-permitted');
  const reading = device.read('2a37', { service: other });
  expect(callsOf('read')[0]?.args.slice(2, 4)).toEqual([other, CHARACTERISTIC]);
  answer(callsOf('read')[0], new Uint8Array([1]));
  await reading;
});

test('operations on a disconnected device fail at once', async () => {
  const device = getDevice('idle');
  expect(await code(device.read('2a37'))).toBe('not-connected');
  expect(thrownCode(() => device.subscribe('2a37', () => {}))).toBe(
    'not-connected'
  );
  expect(device.maxWriteLength()).toBe(0);
  expect(calls).toEqual([]);
});

test('a write longer than one write can carry is refused before it reaches native', async () => {
  const device = await connected();
  returns.maxWriteLength = 20;
  expect(await code(device.write('2a37', new Uint8Array(21)))).toBe(
    'invalid-argument'
  );
  expect(callsOf('write')).toHaveLength(0);
  const writing = device.write('2a37', new Uint8Array(20));
  answer(callsOf('write')[0]);
  await writing;
});

test('a PSM outside 16 bits is refused before it reaches native', async () => {
  const device = await connected();
  for (const psm of [-1, 0, 0x10000, 1.5, Number.NaN]) {
    expect(await code(device.openL2capChannel(psm))).toBe('invalid-argument');
  }
  expect(callsOf('openL2capChannel')).toHaveLength(0);
});

test('writing the CCCD is refused; use subscribe()', async () => {
  const device = await connected();
  expect(
    await code(device.writeDescriptor('2a37', '2902', new Uint8Array([1, 0])))
  ).toBe('not-permitted');
  expect(
    await code(device.writeDescriptor('2a37', '2901', new Uint8Array([1])))
  ).toBe('not-found');
  expect(callsOf('writeDescriptor')).toHaveLength(0);
});

test('a call native refuses rejects instead of waiting forever', async () => {
  const device = await connected();
  returns.read = false;
  expect(await code(device.read('2a37'))).toBe('unknown');
});

test('a device with a listener outlives every reference to it', async () => {
  const states: string[] = [];
  (() => {
    getDevice('held').onStateChange((state) => states.push(state));
  })();
  // A WeakRef keeps its target alive until the current job ends, so collect after it.
  await settle();
  Bun.gc(true);
  emit('connection', { deviceId: 'held', state: 'connecting' });
  expect(states).toEqual(['connecting']);
});

test('a device without a connection or listeners is not held', async () => {
  let ref: WeakRef<object> | undefined;
  (() => {
    const device = getDevice('released');
    device.onStateChange(() => {})();
    ref = new WeakRef(device);
  })();
  await settle();
  Bun.gc(true);
  expect(ref?.deref()).toBeUndefined();
});
