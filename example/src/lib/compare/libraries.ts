import * as Ble from '@wekor/react-native-ble';
import { BleManager, ScanMode, State } from 'react-native-ble-plx';
import { Platform } from 'react-native';

/** What the comparison needs from a BLE library, for one device and one characteristic. */
export type Library = {
  name: 'ours' | 'plx';
  /** Settles once the library can talk to Bluetooth. */
  ready: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<unknown>;
  state: () => unknown;
  /** One read-only GATT operation: the characteristic's value when readable, else its CCCD. */
  read: () => Promise<unknown>;
  subscribe: (onError: (error: unknown) => void) => () => void;
  scan: (onAdvertisement: () => void) => () => void;
  isConnected: () => Promise<boolean> | boolean;
};

export type Target = {
  deviceId: string;
  service: string;
  characteristic: string;
  readable: boolean;
};

const CCCD = '00002902-0000-1000-8000-00805f9b34fb';

export const ours = ({
  deviceId,
  service,
  characteristic,
  readable,
}: Target): Library => {
  const device = Ble.getDevice(deviceId);
  return {
    name: 'ours',
    ready: async () => {},
    connect: () => device.connect(),
    disconnect: () => device.disconnect(),
    state: () => Ble.getBluetoothState(),
    read: () =>
      readable
        ? device.read(characteristic, { service })
        : device.readDescriptor(characteristic, CCCD, { service }),
    subscribe: (onError) =>
      device.subscribe(characteristic, () => {}, { service, onError }),
    scan: (onAdvertisement) =>
      Ble.startScan({ allowDuplicates: true, onFound: onAdvertisement }),
    isConnected: () => device.state === 'connected',
  };
};

let manager: BleManager | undefined;

/** The one plx manager of the app, shared by every comparison. */
export const plxManager = () => {
  manager ??= new BleManager();
  return manager;
};

/** Settles once plx knows Bluetooth is on; it fails calls made before. */
export const plxReady = (m: BleManager) =>
  new Promise<void>((resolve) => {
    const subscription = m.onStateChange((state) => {
      if (state !== State.PoweredOn) return;
      subscription.remove();
      resolve();
    }, true);
  });

/** Connects with plx and discovers, requesting the same MTU on Android as ours. */
export const plxConnect = async (m: BleManager, deviceId: string) => {
  const device = await m.connectToDevice(
    deviceId,
    Platform.OS === 'android' ? { requestMTU: 517 } : {}
  );
  await m.discoverAllServicesAndCharacteristicsForDevice(deviceId);
  return device;
};

/**
 * react-native-ble-plx with the settings that make it comparable: it waits for Bluetooth to be on (plx fails
 * calls made before it knows), and on Android requests the same MTU and scans in the same mode as ours.
 */
export const plx = ({
  deviceId,
  service,
  characteristic,
  readable,
}: Target): Library => {
  const m = plxManager();
  return {
    name: 'plx',
    ready: () => plxReady(m),
    connect: async () => {
      await plxConnect(m, deviceId);
    },
    disconnect: () => m.cancelDeviceConnection(deviceId),
    state: () => m.state(),
    read: () =>
      readable
        ? m.readCharacteristicForDevice(deviceId, service, characteristic)
        : m.readDescriptorForDevice(deviceId, service, characteristic, CCCD),
    subscribe: (onError) => {
      const subscription = m.monitorCharacteristicForDevice(
        deviceId,
        service,
        characteristic,
        (error) => {
          if (error) onError(error);
        }
      );
      return () => subscription.remove();
    },
    scan: (onAdvertisement) => {
      m.startDeviceScan(
        null,
        { allowDuplicates: true, scanMode: ScanMode.LowLatency },
        (error, device) => {
          if (!error && device) onAdvertisement();
        }
      );
      return () => void m.stopDeviceScan();
    },
    isConnected: () => m.isDeviceConnected(deviceId),
  };
};
