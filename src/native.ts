import { BleError, errorOf, type NativeError, toBleError } from './errors';
import Native from './NativeReactNativeBle';
import type {
  BluetoothState,
  CharacteristicProperties,
  ConnectionState,
  LogEntry,
  ScanResult,
} from './types';

/** JSI functions the native module installs on `globalThis` when it is created. */
type Bindings = {
  putBytes: (bytes: Uint8Array) => number;
  addScan: (scanId: number, spec: object) => object | null;
  removeScan: (scanId: number) => object | null;
  clearScans: () => void;
};

type LostDevice = { scanId: number; deviceId: string };

export type NativeService = {
  uuid: string;
  isPrimary: boolean;
  characteristics: {
    uuid: string;
    properties: CharacteristicProperties;
    descriptors: string[];
  }[];
};

/** A `ScanResult` with the device as its id and name. */
export type NativeAdvertisement = Omit<ScanResult, 'device'> & {
  deviceId: string;
  name?: string;
};

export type NativeDevice = { id: string; name?: string };

export type NativeConnection = { mtu: number; services: NativeService[] };

/** Every event type native sends, with its payload; iOS and Android send the same shapes. */
type Events = {
  result: { opId: number; error?: NativeError; value?: unknown };
  state: { state: BluetoothState };
  connection: { deviceId: string; state: ConnectionState };
  disconnected: { deviceId: string; error?: NativeError };
  notification: {
    deviceId: string;
    service: string;
    characteristic: string;
    value: Uint8Array;
  };
  mtu: { deviceId: string; mtu: number };
  servicesChanged: { deviceId: string };
  scan: { scanIds: number[]; advertisement: NativeAdvertisement };
  scanLost: LostDevice[];
  scanError: { error: NativeError };
  l2capData: { channelId: number; value: Uint8Array };
  l2capClosed: { channelId: number; error?: NativeError };
  restore: {
    connected: (NativeDevice & NativeConnection)[];
    /** Connects still pending from before iOS terminated the app. */
    connecting: NativeDevice[];
    scan?: { services: string[] };
  };
  log: LogEntry;
};

type Handlers = { [Type in keyof Events]?: (payload: Events[Type]) => void };

declare global {
  var __ReactNativeBleBindings: Bindings | undefined;
  var __ReactNativeBleHandler:
    | ((type: string, payload: unknown) => void)
    | undefined;
}

export const native = Native;

export const bindings = () => {
  const installed = globalThis.__ReactNativeBleBindings;
  if (!installed)
    throw new Error(
      '@wekor/react-native-ble: the JSI bindings are missing; the New Architecture is required'
    );
  return installed;
};

/** `value` if it is one of `values`, else `fallback`: native may report a value this version does not know. */
export const oneOf = <T extends string>(
  value: string,
  values: readonly T[],
  fallback: T
): T =>
  (values as readonly string[]).includes(value) ? (value as T) : fallback;

/** Stores `bytes` in the shared byte store for the native call that takes them. */
export const putBytes = (bytes: Uint8Array) => bindings().putBytes(bytes);

const handlers: Handlers = {};

/**
 * Sets the one handler for a native event type. Native sends every event through a single global function,
 * since it cannot safely hold JS functions across reloads.
 */
export const setEventHandler = <Type extends keyof Events>(
  type: Type,
  handler: (payload: Events[Type]) => void
) => {
  handlers[type] = handler as Handlers[Type];
};

globalThis.__ReactNativeBleHandler = (type, payload) => {
  const handler = handlers[type as keyof Events] as
    | ((payload: unknown) => void)
    | undefined;
  try {
    handler?.(payload);
  } catch (error) {
    console.error(`[ble] handling '${type}' threw`, error);
  }
};

type PendingOp = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  apply: ((value: unknown) => void) | undefined;
  fail: ((error: BleError) => void) | undefined;
};

let nextOpId = 1;
const pendingOps = new Map<number, PendingOp>();

setEventHandler('result', ({ opId, error, value }) => {
  const op = pendingOps.get(opId);
  if (!op) return;
  pendingOps.delete(opId);
  if (error) {
    const failure = errorOf(error);
    try {
      op.fail?.(failure);
    } finally {
      op.reject(failure);
    }
    return;
  }
  try {
    op.apply?.(value);
  } catch (failure) {
    op.reject(failure);
    return;
  }
  op.resolve(value);
});

/**
 * Runs one native operation: `start` enqueues it under a fresh id and its `result` event settles it exactly once.
 *
 * `apply` handles a successful value and `fail` a failure, synchronously inside the `result` event. Native
 * delivers events in batches and promise continuations run after the whole batch, so a side effect placed after
 * `await` would run after later events such as `disconnected` or `notification`, and could undo or reorder them.
 */
export const request = <T = void>(
  start: (opId: number) => unknown,
  apply?: (value: T) => void,
  fail?: (error: BleError) => void
) =>
  new Promise<T>((resolve, reject) => {
    const opId = nextOpId++;
    pendingOps.set(opId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      apply: apply as ((value: unknown) => void) | undefined,
      fail,
    });
    const refuse = (error: unknown) => {
      pendingOps.delete(opId);
      try {
        fail?.(toBleError(error));
      } finally {
        reject(error);
      }
    };
    try {
      // `false` means native did not take the call, so no `result` will come.
      if (start(opId) === false)
        refuse(new BleError('unknown', 'The native module refused the call'));
    } catch (error) {
      refuse(error);
    }
  });
