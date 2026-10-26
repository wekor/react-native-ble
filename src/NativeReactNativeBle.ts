import {
  type CodegenTypes,
  type TurboModule,
  TurboModuleRegistry,
} from 'react-native';

/**
 * The control plane. Every method is synchronous so calls reach the native queue in the order JS makes them;
 * methods taking an `opId` only enqueue work and answer later with a `result` event carrying that id.
 * Bytes travel as handles into a shared C++ byte store, since codegen has no ArrayBuffer before RN 0.87.
 */
export interface Spec extends TurboModule {
  configure(options: CodegenTypes.UnsafeObject): boolean;
  getState(): string;
  getPermission(opId: CodegenTypes.Double): boolean;
  requestPermission(opId: CodegenTypes.Double): boolean;
  /** Sets the one native scan that covers every JS scan; `null` stops scanning. */
  setScan(config: CodegenTypes.UnsafeObject | null): boolean;

  connect(
    opId: CodegenTypes.Double,
    deviceId: string,
    options: CodegenTypes.UnsafeObject
  ): boolean;
  disconnect(opId: CodegenTypes.Double, deviceId: string): boolean;
  read(
    opId: CodegenTypes.Double,
    deviceId: string,
    service: string,
    characteristic: string,
    timeout: CodegenTypes.Double
  ): boolean;
  write(
    opId: CodegenTypes.Double,
    deviceId: string,
    service: string,
    characteristic: string,
    valueHandle: CodegenTypes.Double,
    withoutResponse: boolean,
    timeout: CodegenTypes.Double
  ): boolean;
  setNotify(
    opId: CodegenTypes.Double,
    deviceId: string,
    service: string,
    characteristic: string,
    enable: boolean,
    indicate: boolean,
    timeout: CodegenTypes.Double
  ): boolean;
  readDescriptor(
    opId: CodegenTypes.Double,
    deviceId: string,
    service: string,
    characteristic: string,
    descriptor: string,
    timeout: CodegenTypes.Double
  ): boolean;
  writeDescriptor(
    opId: CodegenTypes.Double,
    deviceId: string,
    service: string,
    characteristic: string,
    descriptor: string,
    valueHandle: CodegenTypes.Double,
    timeout: CodegenTypes.Double
  ): boolean;
  readRssi(
    opId: CodegenTypes.Double,
    deviceId: string,
    timeout: CodegenTypes.Double
  ): boolean;
  /** Rediscovers services after a `servicesChanged` event; answers with the new services. */
  rediscoverServices(
    opId: CodegenTypes.Double,
    deviceId: string,
    timeout: CodegenTypes.Double
  ): boolean;
  maxWriteLength(
    deviceId: string,
    withoutResponse: boolean
  ): CodegenTypes.Double;
  getConnectedDevices(opId: CodegenTypes.Double, services: string[]): boolean;

  openL2capChannel(
    opId: CodegenTypes.Double,
    deviceId: string,
    psm: CodegenTypes.Double,
    secure: boolean,
    timeout: CodegenTypes.Double
  ): boolean;
  writeL2capChannel(
    opId: CodegenTypes.Double,
    channelId: CodegenTypes.Double,
    valueHandle: CodegenTypes.Double
  ): boolean;
  closeL2capChannel(
    opId: CodegenTypes.Double,
    channelId: CodegenTypes.Double
  ): boolean;

  // Android only; on iOS the ops answer with `unsupported` and `getBondState` returns `'none'`.
  requestEnable(opId: CodegenTypes.Double): boolean;
  getBondedDevices(opId: CodegenTypes.Double): boolean;
  requestMtu(
    opId: CodegenTypes.Double,
    deviceId: string,
    mtu: CodegenTypes.Double,
    timeout: CodegenTypes.Double
  ): boolean;
  requestPriority(
    opId: CodegenTypes.Double,
    deviceId: string,
    priority: string
  ): boolean;
  setPhy(
    opId: CodegenTypes.Double,
    deviceId: string,
    options: CodegenTypes.UnsafeObject,
    timeout: CodegenTypes.Double
  ): boolean;
  readPhy(
    opId: CodegenTypes.Double,
    deviceId: string,
    timeout: CodegenTypes.Double
  ): boolean;
  bond(opId: CodegenTypes.Double, deviceId: string): boolean;
  unbond(opId: CodegenTypes.Double, deviceId: string): boolean;
  getBondState(deviceId: string): string;
  refreshCache(
    opId: CodegenTypes.Double,
    deviceId: string,
    timeout: CodegenTypes.Double
  ): boolean;

  // iOS only.
  getAncsAuthorized(deviceId: string): boolean;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ReactNativeBle');
