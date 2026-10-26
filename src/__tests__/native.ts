/**
 * A scripted native side: every call is recorded and an op settles only when a test answers it, as the native
 * GATT queue would. Import this before the library so the mocks are in place.
 */
import { mock } from 'bun:test';

type Call = { name: string; args: unknown[] };

export const calls: Call[] = [];

/** What a native method returns instead of `true`, by name. */
export const returns: Record<string, unknown> = {};

const native = new Proxy(
  {},
  {
    get:
      (_, name: string) =>
      (...args: unknown[]) => {
        calls.push({ name, args });
        return name in returns ? returns[name] : true;
      },
  }
);

/**
 * A switchable `Platform.OS`. Devices pick their platform members when created, so set `platform.OS = 'android'`
 * before creating devices to test Android, and reset it afterwards.
 */
export const platform: { OS: 'ios' | 'android' } = { OS: 'ios' };

mock.module('react-native', () => ({
  Platform: platform,
  TurboModuleRegistry: { getEnforcing: () => native },
}));
mock.module('../NativeReactNativeBle', () => ({ default: native }));

/** The ids of the scans started, in order, and the spec each was started with. */
export const scanIds: number[] = [];
export const scanSpecs: { tracksPresence: boolean }[] = [];

globalThis.__ReactNativeBleBindings = {
  putBytes: () => 1,
  addScan: (scanId: number, spec: object) => {
    scanIds.push(scanId);
    scanSpecs.push(spec as { tracksPresence: boolean });
    return { scanId };
  },
  removeScan: () => null,
  clearScans: () => {},
};

export const emit = (type: string, payload: unknown) =>
  globalThis.__ReactNativeBleHandler?.(type, payload);

/** The calls named `name`, in order. */
export const callsOf = (name: string) =>
  calls.filter((call) => call.name === name);

/** Answers the op `call` started; every op takes its id as the first argument. */
export const answer = (call: Call | undefined, value?: unknown) => {
  if (!call) throw new Error('No such call');
  emit('result', { opId: call.args[0], value });
};

export const answerError = (call: Call | undefined, code: string) => {
  if (!call) throw new Error('No such call');
  emit('result', { opId: call.args[0], error: { code, message: code } });
};

/** Lets pending promise callbacks run. */
export const settle = () =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

export const SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
export const CHARACTERISTIC = '00002a37-0000-1000-8000-00805f9b34fb';
const CCCD = '00002902-0000-1000-8000-00805f9b34fb';

export const services = [
  {
    uuid: SERVICE,
    isPrimary: true,
    characteristics: [
      {
        uuid: CHARACTERISTIC,
        descriptors: [CCCD],
        properties: {
          broadcast: false,
          read: true,
          writeWithoutResponse: false,
          write: true,
          notify: true,
          indicate: false,
          authenticatedSignedWrites: false,
          extendedProperties: false,
        },
      },
    ],
  },
];

let nextDevice = 1;

/** A fresh device, connected with `withServices`; the calls are cleared afterwards. */
export const connectedDevice = async (withServices: unknown = services) => {
  const { getDevice } = await import('../index');
  const device = getDevice(`device-${nextDevice++}`);
  const connecting = device.connect();
  answer(callsOf('connect').at(-1), { mtu: 185, services: withServices });
  await connecting;
  calls.length = 0;
  return device;
};

/** The error `promise` rejects with, or `undefined` when it resolves. */
export const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error
  );

/** The `code` of the error `run` throws. */
export const thrownCode = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};
