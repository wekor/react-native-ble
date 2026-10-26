import type { BleError } from './errors';

export type PermissionResponse = {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never';
};

export type BluetoothState =
  | 'unknown'
  | 'unsupported'
  | 'unauthorized'
  | 'off'
  | 'turning-on'
  | 'on'
  | 'turning-off'
  | 'resetting';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting';

export type Phy = 'le1m' | 'le2m' | 'coded';

export type PhyPair = { tx: Phy; rx: Phy };

export type BondState = 'none' | 'bonding' | 'bonded';

export type ConnectionPriority = 'balanced' | 'high' | 'low-power';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TimeoutOptions = { timeout?: number };

export type ScanFilter = {
  name?: string;
  namePrefix?: string;
  manufacturerData?: {
    companyId: number;
    data?: Uint8Array;
    mask?: Uint8Array;
  };
  serviceData?: { uuid: string; data?: Uint8Array; mask?: Uint8Array };
};

export type ScanOptionsAndroid = {
  scanMode?:
    | 'auto'
    | 'opportunistic'
    | 'low-power'
    | 'balanced'
    | 'low-latency';
  reportDelay?: number;
  legacy?: boolean;
  phy?: 'le1m' | 'coded' | 'all';
};

export type ScanOptionsIos = {
  solicitedServices?: string[];
};

export type ScanResult = {
  device: Device;
  rssi: number;
  manufacturerData?: Uint8Array;
  serviceData: Record<string, Uint8Array>;
  serviceUuids: string[];
  txPowerLevel?: number;
  isConnectable?: boolean;
  android?: {
    /** Every manufacturer data entry, each starting with its company id; `manufacturerData` is the first. */
    manufacturerEntries: Uint8Array[];
    scanRecord: Uint8Array;
    isLegacy: boolean;
    primaryPhy: 'le1m' | 'coded';
    secondaryPhy?: Phy;
    advertisingSid?: number;
    periodicAdvertisingInterval?: number;
    timestampNanos: number;
  };
  ios?: {
    overflowServiceUuids: string[];
    solicitedServiceUuids: string[];
  };
};

export type ScanOptions = {
  services?: string[];
  filters?: ScanFilter[];
  allowDuplicates?: boolean;
  minRssi?: number;
  lostAfter?: number;
  onFound?: (result: ScanResult) => void;
  onLost?: (device: Device) => void;
  onError?: (error: BleError) => void;
  android?: ScanOptionsAndroid;
  ios?: ScanOptionsIos;
};

export type CharacteristicProperties = {
  broadcast: boolean;
  read: boolean;
  writeWithoutResponse: boolean;
  write: boolean;
  notify: boolean;
  indicate: boolean;
  authenticatedSignedWrites: boolean;
  extendedProperties: boolean;
};

export type Descriptor = { uuid: string; characteristic: string };

export type Characteristic = {
  uuid: string;
  service: string;
  properties: CharacteristicProperties;
  descriptors: Descriptor[];
};

export type Service = {
  uuid: string;
  isPrimary: boolean;
  characteristics: Characteristic[];
};

export type ConnectOptions = {
  timeout?: number;
  services?: string[];
  android?: {
    autoConnect?: boolean;
    transport?: 'auto' | 'le' | 'bredr';
    phy?: Phy[];
    mtu?: number | false;
    priority?: ConnectionPriority;
  };
  ios?: {
    notifyOnConnection?: boolean;
    notifyOnDisconnection?: boolean;
    notifyOnNotification?: boolean;
    enableTransportBridging?: boolean;
    requiresAncs?: boolean;
    startDelay?: number;
  };
};

export type CharacteristicOptions = TimeoutOptions & {
  service?: string;
};

export type WriteOptions = CharacteristicOptions & {
  withoutResponse?: boolean;
};

export type SubscribeOptions = CharacteristicOptions & {
  mode?: 'auto' | 'notify' | 'indicate';
  onError?: (error: BleError) => void;
};

export type L2capChannelOptions = TimeoutOptions & {
  android?: { secure?: boolean };
};

export type L2capChannel = {
  readonly psm: number;
  write(value: Uint8Array): Promise<void>;
  onData(listener: (value: Uint8Array) => void): () => void;
  onClose(listener: (error?: BleError) => void): () => void;
  close(): Promise<void>;
};

export type DeviceAndroid = {
  requestMtu(mtu: number, options?: TimeoutOptions): Promise<number>;
  requestPriority(priority: ConnectionPriority): Promise<void>;
  setPhy(
    phy: {
      tx?: Phy[];
      rx?: Phy[];
      codedOption?: 'none' | 's2' | 's8';
    },
    options?: TimeoutOptions
  ): Promise<PhyPair>;
  readPhy(options?: TimeoutOptions): Promise<PhyPair>;
  bond(): Promise<void>;
  unbond(): Promise<void>;
  readonly bondState: BondState;
  refreshCache(options?: TimeoutOptions): Promise<void>;
};

export type DeviceIos = {
  readonly ancsAuthorized: boolean;
};

export interface Device {
  readonly id: string;
  readonly name: string | undefined;
  readonly state: ConnectionState;
  readonly mtu: number;
  readonly services: Service[];
  readonly android: DeviceAndroid | undefined;
  readonly ios: DeviceIos | undefined;

  connect(options?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;

  read(
    characteristic: string,
    options?: CharacteristicOptions
  ): Promise<Uint8Array>;
  write(
    characteristic: string,
    value: Uint8Array,
    options?: WriteOptions
  ): Promise<void>;
  readDescriptor(
    characteristic: string,
    descriptor: string,
    options?: CharacteristicOptions
  ): Promise<Uint8Array>;
  writeDescriptor(
    characteristic: string,
    descriptor: string,
    value: Uint8Array,
    options?: CharacteristicOptions
  ): Promise<void>;
  maxWriteLength(options?: { withoutResponse?: boolean }): number;
  readRssi(options?: TimeoutOptions): Promise<number>;
  openL2capChannel(
    psm: number,
    options?: L2capChannelOptions
  ): Promise<L2capChannel>;

  subscribe(
    characteristic: string,
    listener: (value: Uint8Array) => void,
    options?: SubscribeOptions
  ): () => void;
  onDisconnect(listener: (error?: BleError) => void): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
}

export type LogEntry = {
  level: LogLevel;
  message: string;
  deviceId?: string;
  details?: Record<string, unknown>;
};

export type RestoredState = {
  /** Devices iOS reconnected, with services already discovered. */
  connected: Device[];
  /** Devices whose connect was still pending; each has a `connect({ timeout: 0 })` running again. */
  connecting: Device[];
  scan?: { services: string[] };
};

export type ConfigureOptions = {
  timeouts?: { connect?: number; operation?: number };
  logLevel?: LogLevel | 'off';
  logger?: (entry: LogEntry) => void;
  ios?: {
    showPowerAlert?: boolean;
    restoreIdentifier?: string;
    onRestore?: (state: RestoredState) => void;
  };
};
