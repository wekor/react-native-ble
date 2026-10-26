import { Platform } from 'react-native';
import { operationTimeout, settings } from './config';
import { BleError, errorOf, isBleError } from './errors';
import { createL2capChannel } from './l2cap';
import { Listeners } from './listeners';
import {
  type NativeConnection,
  type NativeService,
  native,
  oneOf,
  putBytes,
  request,
  setEventHandler,
} from './native';
import type {
  BondState,
  Characteristic,
  CharacteristicOptions,
  CharacteristicProperties,
  ConnectionState,
  ConnectOptions,
  Device,
  DeviceAndroid,
  DeviceIos,
  L2capChannel,
  L2capChannelOptions,
  PhyPair,
  Service,
  SubscribeOptions,
  TimeoutOptions,
  WriteOptions,
} from './types';
import { normalizeUuid } from './uuid';

const DEFAULT_MTU = 23;
/** The largest MTU Android accepts; `connect()` requests it unless `android.mtu` says otherwise. */
const MAX_MTU = 517;
const CCCD = normalizeUuid('2902');

const servicesOf = (services: NativeService[]): Service[] =>
  services.map((service) => ({
    uuid: service.uuid,
    isPrimary: service.isPrimary,
    characteristics: service.characteristics.map((characteristic) => ({
      uuid: characteristic.uuid,
      service: service.uuid,
      properties: characteristic.properties,
      descriptors: characteristic.descriptors.map((uuid) => ({
        uuid,
        characteristic: characteristic.uuid,
      })),
    })),
  }));

const BOND_STATES: readonly BondState[] = ['none', 'bonding', 'bonded'];

const assertSupports = (
  characteristic: Characteristic,
  property: keyof CharacteristicProperties
) => {
  if (!characteristic.properties[property]) {
    throw new BleError(
      'not-permitted',
      `Characteristic ${characteristic.uuid} does not support ${property}`
    );
  }
};

const keyOf = (service: string, characteristic: string) =>
  `${service}|${characteristic}`;

/** One `subscribe()` call; the same listener subscribed twice is two subscriptions. */
type Subscriber = {
  listener: (value: Uint8Array) => void;
  onError?: (error: BleError) => void;
};

/**
 * Notifications of one characteristic, enabled on the device once for all its subscribers. It stays in
 * `subscriptions` until disabled, even with no subscribers, so a new `subscribe()` reuses its pending enable instead
 * of racing it with a second one.
 */
type Subscription = {
  characteristic: Characteristic;
  indicate: boolean;
  subscribers: Set<Subscriber>;
  /** The first subscriber's timeout, used for every enable, including those after a services change. */
  timeout: number | undefined;
  enabled: boolean;
  /** Counts enables so that only the latest one's answer is applied. */
  attempt: number;
};

class BleDevice implements Device {
  readonly id: string;
  name: string | undefined;
  state: ConnectionState = 'disconnected';
  mtu = DEFAULT_MTU;
  services: Service[] = [];
  readonly android: DeviceAndroid | undefined;
  readonly ios: DeviceIos | undefined;

  private connecting: Promise<void> | undefined;
  /** Counts ended connections, so a result arriving after its connection ended is not applied to the next. */
  private generation = 0;
  /** Disconnects not yet confirmed; `state` stays `'connected'` until native reports the change. */
  private pendingDisconnects = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly disconnectListeners = new Listeners<
    (error?: BleError) => void
  >();
  private readonly stateListeners = new Listeners<
    (state: ConnectionState) => void
  >();

  constructor(id: string, name?: string) {
    this.id = id;
    this.name = name;
    this.android = Platform.OS === 'android' ? this.createAndroid() : undefined;
    this.ios = Platform.OS === 'ios' ? this.createIos() : undefined;
  }

  // Connecting

  connect(options: ConnectOptions = {}) {
    // While a disconnect is in flight, native queues the connect until it ends.
    if (this.state === 'connected' && this.pendingDisconnects === 0)
      return Promise.resolve();
    if (!this.connecting) {
      const connecting = this.startConnect(options).finally(() => {
        // A `disconnect()` meanwhile may have let a newer connect take over.
        if (this.connecting === connecting) this.connecting = undefined;
        this.updateRetention();
      });
      this.connecting = connecting;
      this.updateRetention();
    }
    return this.connecting;
  }

  private async startConnect({
    timeout,
    services,
    android = {},
    ios = {},
  }: ConnectOptions) {
    const options = {
      timeout: timeout ?? settings.timeouts.connect,
      services: services ? services.map(normalizeUuid) : null,
      android: {
        autoConnect: android.autoConnect ?? false,
        transport: android.transport ?? 'le',
        phy: android.phy ?? ['le1m'],
        mtu: android.mtu === false ? 0 : (android.mtu ?? MAX_MTU),
        priority: android.priority ?? 'balanced',
      },
      ios: {
        notifyOnConnection: ios.notifyOnConnection ?? false,
        notifyOnDisconnection: ios.notifyOnDisconnection ?? false,
        notifyOnNotification: ios.notifyOnNotification ?? false,
        enableTransportBridging: ios.enableTransportBridging ?? false,
        requiresAncs: ios.requiresAncs ?? false,
        startDelay: ios.startDelay ?? 0,
      },
    };
    await request<NativeConnection>(
      (opId) => native.connect(opId, this.id, options),
      (ready) => {
        // Settled now, not after `await`: a disconnect in the same batch must let a `connect()` start anew.
        this.connecting = undefined;
        this.adopt(ready);
      }
    );
  }

  /** Applies the MTU and services that `connect()` or a restore reported. */
  adopt({ mtu, services }: NativeConnection) {
    this.mtu = mtu;
    this.services = servicesOf(services);
    this.setState('connected');
  }

  disconnect() {
    // The pending connect ends with `cancelled`; a `connect()` from here on starts a new one.
    this.connecting = undefined;
    this.updateRetention();
    this.pendingDisconnects++;
    return request((opId) => native.disconnect(opId, this.id)).finally(() => {
      this.pendingDisconnects--;
    });
  }

  setState(state: ConnectionState) {
    if (state === this.state) return;
    this.state = state;
    this.updateRetention();
    for (const listener of this.stateListeners.list()) listener(state);
  }

  /** Ends everything that lived on the connection, which has ended. */
  endConnection(error?: BleError) {
    this.services = [];
    this.mtu = DEFAULT_MTU;
    this.subscriptions.clear();
    this.generation++;
    this.setState('disconnected');
    for (const listener of this.disconnectListeners.list()) listener(error);
  }

  // Reading and writing

  private assertConnected() {
    if (this.state !== 'connected')
      throw new BleError('not-connected', `${this.id} is not connected`);
  }

  /** Wraps `apply` so it runs only if the current connection is still the one it was created on. */
  private onThisConnection<T>(apply: (value: T) => void) {
    const generation = this.generation;
    return (value: T) => {
      if (generation === this.generation) apply(value);
    };
  }

  /** Finds the discovered `characteristic` and checks it has the property the operation needs. */
  private findCharacteristic(
    characteristic: string,
    service: string | undefined,
    property?: keyof CharacteristicProperties
  ) {
    this.assertConnected();
    const characteristicUuid = normalizeUuid(characteristic);
    const serviceUuid =
      service === undefined ? undefined : normalizeUuid(service);
    const matches: Characteristic[] = [];
    for (const candidate of this.services) {
      if (serviceUuid !== undefined && candidate.uuid !== serviceUuid) continue;
      for (const entry of candidate.characteristics)
        if (entry.uuid === characteristicUuid) matches.push(entry);
    }
    const [found] = matches;
    if (!found) {
      throw new BleError(
        'not-found',
        `No characteristic ${characteristicUuid}${serviceUuid ? ` in service ${serviceUuid}` : ''}`
      );
    }
    if (matches.length > 1) {
      throw new BleError(
        'ambiguous',
        `Characteristic ${characteristicUuid} exists in several services; pass \`service\``
      );
    }
    if (property) assertSupports(found, property);
    return found;
  }

  private findDescriptor(
    characteristic: string,
    descriptor: string,
    service: string | undefined
  ) {
    const found = this.findCharacteristic(characteristic, service);
    const descriptorUuid = normalizeUuid(descriptor);
    if (!found.descriptors.some((entry) => entry.uuid === descriptorUuid)) {
      throw new BleError(
        'not-found',
        `No descriptor ${descriptorUuid} on characteristic ${found.uuid}`
      );
    }
    return { found, descriptorUuid };
  }

  async read(
    characteristic: string,
    { service, timeout }: CharacteristicOptions = {}
  ) {
    const found = this.findCharacteristic(characteristic, service, 'read');
    return request<Uint8Array>(
      (opId) =>
        native.read(
          opId,
          this.id,
          found.service,
          found.uuid,
          operationTimeout(timeout)
        ),
      // Subscribers see read values too, in order with notifications, on copies separate from the returned one.
      this.onThisConnection((value) =>
        this.deliver(found.service, found.uuid, value, false)
      )
    );
  }

  async write(
    characteristic: string,
    value: Uint8Array,
    { service, timeout, withoutResponse = false }: WriteOptions = {}
  ) {
    const found = this.findCharacteristic(
      characteristic,
      service,
      withoutResponse ? 'writeWithoutResponse' : 'write'
    );
    const max = this.maxWriteLength({ withoutResponse });
    if (value.length > max) {
      throw new BleError(
        'invalid-argument',
        `${value.length} bytes exceed the ${max} one write can carry`
      );
    }
    await request((opId) =>
      native.write(
        opId,
        this.id,
        found.service,
        found.uuid,
        putBytes(value),
        withoutResponse,
        operationTimeout(timeout)
      )
    );
  }

  async readDescriptor(
    characteristic: string,
    descriptor: string,
    { service, timeout }: CharacteristicOptions = {}
  ) {
    const { found, descriptorUuid } = this.findDescriptor(
      characteristic,
      descriptor,
      service
    );
    return request<Uint8Array>((opId) =>
      native.readDescriptor(
        opId,
        this.id,
        found.service,
        found.uuid,
        descriptorUuid,
        operationTimeout(timeout)
      )
    );
  }

  async writeDescriptor(
    characteristic: string,
    descriptor: string,
    value: Uint8Array,
    { service, timeout }: CharacteristicOptions = {}
  ) {
    const { found, descriptorUuid } = this.findDescriptor(
      characteristic,
      descriptor,
      service
    );
    if (descriptorUuid === CCCD)
      throw new BleError(
        'not-permitted',
        'Use subscribe() instead of writing the CCCD (2902)'
      );
    await request((opId) =>
      native.writeDescriptor(
        opId,
        this.id,
        found.service,
        found.uuid,
        descriptorUuid,
        putBytes(value),
        operationTimeout(timeout)
      )
    );
  }

  maxWriteLength({
    withoutResponse = false,
  }: {
    withoutResponse?: boolean;
  } = {}) {
    if (this.state !== 'connected') return 0;
    return native.maxWriteLength(this.id, withoutResponse);
  }

  async readRssi({ timeout }: TimeoutOptions = {}) {
    this.assertConnected();
    return request<number>((opId) =>
      native.readRssi(opId, this.id, operationTimeout(timeout))
    );
  }

  async openL2capChannel(
    psm: number,
    { timeout, android }: L2capChannelOptions = {}
  ) {
    this.assertConnected();
    if (!Number.isInteger(psm) || psm < 1 || psm > 0xffff)
      throw new BleError('invalid-argument', `Not an L2CAP PSM: ${psm}`);
    let channel: L2capChannel | undefined;
    await request<{ channelId: number }>(
      (opId) =>
        native.openL2capChannel(
          opId,
          this.id,
          psm,
          android?.secure ?? true,
          operationTimeout(timeout)
        ),
      ({ channelId }) => {
        channel = createL2capChannel(channelId, psm);
      }
    );
    return channel!;
  }

  // Listening

  subscribe(
    characteristic: string,
    listener: (value: Uint8Array) => void,
    options: SubscribeOptions = {}
  ) {
    const { service, timeout, mode = 'auto', onError } = options;
    const found = this.findCharacteristic(characteristic, service);
    const useIndicate =
      mode === 'indicate' || (mode === 'auto' && !found.properties.notify);
    assertSupports(found, useIndicate ? 'indicate' : 'notify');

    const key = keyOf(found.service, found.uuid);
    const subscription =
      this.subscriptions.get(key) ??
      this.openSubscription(key, found, useIndicate, timeout);
    // Later subscribers share the first one's enable; their own `mode` and `timeout` are ignored.
    const subscriber: Subscriber = { listener, onError };
    subscription.subscribers.add(subscriber);

    return () => {
      if (!subscription.subscribers.delete(subscriber)) return;
      // While still enabling, `enable` closes the subscription once the device answers, unless someone resubscribed.
      if (subscription.enabled) this.closeIfUnused(key, subscription);
    };
  }

  private openSubscription(
    key: string,
    characteristic: Characteristic,
    indicate: boolean,
    timeout: number | undefined
  ) {
    const subscription: Subscription = {
      characteristic,
      indicate,
      subscribers: new Set(),
      timeout,
      enabled: false,
      attempt: 0,
    };
    this.subscriptions.set(key, subscription);
    this.updateRetention();
    this.enable(key, subscription);
    return subscription;
  }

  /** Enables `subscription` on the device, then keeps it only while it has subscribers. */
  private enable(key: string, subscription: Subscription) {
    subscription.enabled = false;
    const attempt = ++subscription.attempt;
    const current = () =>
      this.subscriptions.get(key) === subscription &&
      subscription.attempt === attempt;
    this.setNotify(
      subscription.characteristic,
      true,
      subscription.indicate,
      subscription.timeout,
      () => {
        if (!current()) return;
        subscription.enabled = true;
        this.closeIfUnused(key, subscription);
      },
      (error) => {
        if (!current()) return;
        this.subscriptions.delete(key);
        this.updateRetention();
        // A disconnect ends every subscription without an error; `onDisconnect` says why.
        if (isBleError(error, 'disconnected')) return;
        this.failSubscription(subscription, error);
      }
    ).catch(() => {});
  }

  private closeIfUnused(key: string, subscription: Subscription) {
    if (
      subscription.subscribers.size > 0 ||
      this.subscriptions.get(key) !== subscription
    )
      return;
    this.subscriptions.delete(key);
    this.updateRetention();
    this.setNotify(subscription.characteristic, false);
  }

  private failSubscription(subscription: Subscription, error: BleError) {
    for (const { onError } of [...subscription.subscribers]) onError?.(error);
  }

  /** Rediscovers services after the device sent a Service Changed indication. */
  rediscoverServices() {
    // Both outcomes are handled inside the result.
    request<NativeService[]>(
      (opId) => native.rediscoverServices(opId, this.id, operationTimeout()),
      this.onThisConnection((services) => this.applyServices(services)),
      this.onThisConnection((error) => {
        // A disconnect ends the subscriptions itself; `onDisconnect` reports why.
        if (isBleError(error, 'disconnected')) return;
        // The services are now unknown, so subscriptions end with the reason. The link stays up; `refreshCache()`
        // or a reconnect discovers them again.
        this.applyServices([], error);
      })
    ).catch(() => {});
  }

  /**
   * Applies services that changed while connected (Service Changed indication or `refreshCache()`). Each
   * subscription moves to its characteristic's new instance and is re-enabled, since the device may have
   * forgotten it; one whose characteristic is gone ends with `failure` if given, else with `not-found`.
   */
  applyServices(services: NativeService[], failure?: BleError) {
    this.services = servicesOf(services);
    for (const [key, subscription] of [...this.subscriptions]) {
      const characteristic = this.services
        .find(({ uuid }) => uuid === subscription.characteristic.service)
        ?.characteristics.find(
          ({ uuid }) => uuid === subscription.characteristic.uuid
        );
      if (!characteristic) {
        this.subscriptions.delete(key);
        this.failSubscription(
          subscription,
          failure ??
            new BleError(
              'not-found',
              `Characteristic ${subscription.characteristic.uuid} is gone after the device changed its services`
            )
        );
        continue;
      }
      subscription.characteristic = characteristic;
      this.enable(key, subscription);
    }
    this.updateRetention();
  }

  private setNotify(
    characteristic: Characteristic,
    enable: boolean,
    indicate = false,
    timeout?: number,
    apply?: () => void,
    fail?: (error: BleError) => void
  ) {
    const done = request(
      (opId) =>
        native.setNotify(
          opId,
          this.id,
          characteristic.service,
          characteristic.uuid,
          enable,
          indicate,
          operationTimeout(timeout)
        ),
      apply,
      fail
    );
    // Disabling is best effort: the link may be gone already.
    if (!enable) done.catch(() => {});
    return done;
  }

  /**
   * Passes a notification or read value to every subscriber of the characteristic. Unless `owned`, `value` is
   * also the caller's, so every subscriber gets a copy.
   */
  deliver(
    service: string,
    characteristic: string,
    value: Uint8Array,
    owned = true
  ) {
    const subscription = this.subscriptions.get(keyOf(service, characteristic));
    if (!subscription) return;
    // Every subscriber but the last gets a copy, made before the last sees `value`, so none can mutate another's.
    const subscribers = [...subscription.subscribers];
    const last = owned ? subscribers.length - 1 : -1;
    for (let i = 0; i < subscribers.length; i++)
      subscribers[i]!.listener(i === last ? value : value.slice());
  }

  onDisconnect(listener: (error?: BleError) => void) {
    return this.retainWhile(this.disconnectListeners.add(listener));
  }

  onStateChange(listener: (state: ConnectionState) => void) {
    return this.retainWhile(this.stateListeners.add(listener));
  }

  /** Updates retention for a listener just added, and again when `remove` removes it. */
  private retainWhile(remove: () => void) {
    this.updateRetention();
    return () => {
      remove();
      this.updateRetention();
    };
  }

  /** Holds the device strongly while it has a connection or listeners, so they survive the weak registry. */
  private updateRetention() {
    const active =
      this.state !== 'disconnected' ||
      this.connecting !== undefined ||
      this.subscriptions.size > 0 ||
      this.disconnectListeners.size > 0 ||
      this.stateListeners.size > 0;
    if (active) retained.add(this);
    else retained.delete(this);
  }

  // Platform members

  private createAndroid(): DeviceAndroid {
    const device = this;
    return {
      async requestMtu(mtu, { timeout } = {}) {
        device.assertConnected();
        return request<number>(
          (opId) =>
            native.requestMtu(opId, device.id, mtu, operationTimeout(timeout)),
          device.onThisConnection((accepted) => {
            device.mtu = accepted;
          })
        );
      },
      async requestPriority(priority) {
        device.assertConnected();
        await request((opId) =>
          native.requestPriority(opId, device.id, priority)
        );
      },
      async setPhy(phy, { timeout } = {}) {
        device.assertConnected();
        return request<PhyPair>((opId) =>
          native.setPhy(opId, device.id, phy, operationTimeout(timeout))
        );
      },
      async readPhy({ timeout } = {}) {
        device.assertConnected();
        return request<PhyPair>((opId) =>
          native.readPhy(opId, device.id, operationTimeout(timeout))
        );
      },
      bond: () => request((opId) => native.bond(opId, device.id)),
      unbond: () => request((opId) => native.unbond(opId, device.id)),
      get bondState() {
        return oneOf(native.getBondState(device.id), BOND_STATES, 'none');
      },
      async refreshCache({ timeout } = {}) {
        device.assertConnected();
        await request<NativeConnection>(
          (opId) =>
            native.refreshCache(opId, device.id, operationTimeout(timeout)),
          device.onThisConnection(({ mtu, services }) => {
            device.mtu = mtu;
            device.applyServices(services);
          })
        );
      },
    };
  }

  private createIos(): DeviceIos {
    const device = this;
    return {
      get ancsAuthorized() {
        return native.getAncsAuthorized(device.id);
      },
    };
  }
}

type Ref = { deref(): BleDevice | undefined };

/**
 * Every device by id, held weakly: a long scan sees a new id per advertiser (often random addresses), so strong
 * references would grow without bound. `retained` holds devices with a connection or listeners strongly; any
 * other lives as long as the app references it, and the same id returns the same object meanwhile.
 */
const devices = new Map<string, Ref>();
const retained = new Set<BleDevice>();
const refOf: (device: BleDevice) => Ref =
  typeof WeakRef === 'function'
    ? (device) => new WeakRef(device)
    : (device) => ({ deref: () => device });

const SWEEP_EVERY = 256;
let created = 0;

const findDevice = (id: string) => devices.get(id)?.deref();

/** The one `Device` for `id`, taking a newer `name` when one is known. */
export const deviceOf = (id: string, name?: string) => {
  const existing = findDevice(id);
  if (existing) {
    if (name) existing.name = name;
    return existing;
  }
  // Hermes has no FinalizationRegistry, so collected entries are swept periodically instead.
  if (++created % SWEEP_EVERY === 0) {
    for (const [key, ref] of devices) if (!ref.deref()) devices.delete(key);
  }
  const device = new BleDevice(id, name);
  devices.set(id, refOf(device));
  return device;
};

export const getDevice = (id: string): Device => deviceOf(id);

setEventHandler('connection', ({ deviceId, state }) => {
  // `connected` is set by `adopt` once discovery finishes.
  if (state !== 'connected') findDevice(deviceId)?.setState(state);
});

setEventHandler('disconnected', ({ deviceId, error }) =>
  findDevice(deviceId)?.endConnection(error ? errorOf(error) : undefined)
);

setEventHandler(
  'notification',
  ({ deviceId, service, characteristic, value }) =>
    findDevice(deviceId)?.deliver(service, characteristic, value)
);

setEventHandler('mtu', ({ deviceId, mtu }) => {
  const device = findDevice(deviceId);
  if (device) device.mtu = mtu;
});

setEventHandler('servicesChanged', ({ deviceId }) =>
  findDevice(deviceId)?.rediscoverServices()
);
