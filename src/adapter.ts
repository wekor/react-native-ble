import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Platform } from 'react-native';
import { log, settings } from './config';
import { deviceOf } from './device';
import { Listeners } from './listeners';
import {
  type NativeDevice,
  native,
  oneOf,
  request,
  setEventHandler,
} from './native';
import type {
  BluetoothState,
  ConfigureOptions,
  Device,
  PermissionResponse,
  RestoredState,
} from './types';
import { normalizeUuid } from './uuid';

// Permissions

type NativePermission = {
  status: PermissionResponse['status'];
  canAskAgain: boolean;
};

const responseOf = ({
  status,
  canAskAgain,
}: NativePermission): PermissionResponse => ({
  status,
  granted: status === 'granted',
  canAskAgain,
  expires: 'never',
});

export const getPermission = async () =>
  responseOf(
    await request<NativePermission>((opId) => native.getPermission(opId))
  );

// Native sends the `state` a new permission brings before its result.
export const requestPermission = async () =>
  responseOf(
    await request<NativePermission>((opId) => native.requestPermission(opId))
  );

/**
 * The permission as React state, with the same options and `[status, request, get]` result as Expo's
 * permission hooks such as `useCameraPermissions()`.
 */
export function useBluetoothPermission(options?: {
  get?: boolean;
  request?: boolean;
}) {
  const isMounted = useRef(true);
  const [permission, setPermission] = useState<PermissionResponse | null>(null);
  const { get = true, request = false } = options ?? {};

  const getPermissionStatus = useCallback(async () => {
    const response = await getPermission();
    if (isMounted.current) setPermission(response);
    return response;
  }, []);

  const requestPermissionStatus = useCallback(async () => {
    const response = await requestPermission();
    if (isMounted.current) setPermission(response);
    return response;
  }, []);

  useEffect(() => {
    if (request) requestPermissionStatus();
    if (!request && get) getPermissionStatus();
  }, [get, request, requestPermissionStatus, getPermissionStatus]);

  // A response can arrive after the component unmounted.
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  return [permission, requestPermissionStatus, getPermissionStatus] as const;
}

// Bluetooth state

const BLUETOOTH_STATES: readonly BluetoothState[] = [
  'unknown',
  'unsupported',
  'unauthorized',
  'off',
  'turning-on',
  'on',
  'turning-off',
  'resetting',
];

let state: BluetoothState | undefined;
const stateListeners = new Listeners<(state: BluetoothState) => void>();

const setState = (next: BluetoothState) => {
  if (next === state) return;
  state = next;
  for (const listener of stateListeners.list()) listener(next);
};

setEventHandler('state', ({ state: next }) => setState(next));

export const getBluetoothState = (): BluetoothState => {
  state ??= oneOf(native.getState(), BLUETOOTH_STATES, 'unknown');
  return state;
};

export const onBluetoothStateChange = (
  listener: (state: BluetoothState) => void
) => stateListeners.add(listener);

export const useBluetoothState = () =>
  useSyncExternalStore(onBluetoothStateChange, getBluetoothState);

// Configuration

let onRestore: ((state: RestoredState) => void) | undefined;
let restored: RestoredState | undefined;

setEventHandler('log', log);

setEventHandler('restore', ({ connected, connecting, scan }) => {
  restored = {
    connected: connected.map(({ id, name, mtu, services }) => {
      const device = deviceOf(id, name);
      device.adopt({ mtu, services });
      return device;
    }),
    // iOS kept these connects pending: reissue them without a time limit so each resolves when its device comes
    // into range; an app `connect()` joins the same promise.
    connecting: connecting.map(({ id, name }) => {
      const device = deviceOf(id, name);
      device.connect({ timeout: 0 }).catch(() => {});
      return device;
    }),
    scan,
  };
  onRestore?.(restored);
});

export const configure = (options: ConfigureOptions) => {
  if (options.timeouts)
    settings.timeouts = { ...settings.timeouts, ...options.timeouts };
  if (options.logLevel) settings.logLevel = options.logLevel;
  if (options.logger) settings.logger = options.logger;
  if (options.ios?.onRestore) {
    onRestore = options.ios.onRestore;
    // iOS may deliver the restore before JS registers `onRestore`.
    if (restored) onRestore(restored);
  }
  native.configure({
    logLevel: settings.logLevel,
    ios: {
      showPowerAlert: options.ios?.showPowerAlert,
      restoreIdentifier: options.ios?.restoreIdentifier,
    },
  });
};

// Platform functions

const devicesOf = (list: NativeDevice[]): Device[] =>
  list.map(({ id, name }) => deviceOf(id, name));

export const android =
  Platform.OS === 'android'
    ? {
        requestEnable: () =>
          request<boolean>((opId) => native.requestEnable(opId)),
        getBondedDevices: async () =>
          devicesOf(
            await request<NativeDevice[]>((opId) =>
              native.getBondedDevices(opId)
            )
          ),
        getConnectedDevices: async () =>
          devicesOf(
            await request<NativeDevice[]>((opId) =>
              native.getConnectedDevices(opId, [])
            )
          ),
      }
    : undefined;

export const ios =
  Platform.OS === 'ios'
    ? {
        getConnectedDevices: async (services: string[]) => {
          const uuids = services.map(normalizeUuid);
          return devicesOf(
            await request<NativeDevice[]>((opId) =>
              native.getConnectedDevices(opId, uuids)
            )
          );
        },
      }
    : undefined;
