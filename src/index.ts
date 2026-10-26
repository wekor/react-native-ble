export {
  android,
  configure,
  getBluetoothState,
  getPermission,
  ios,
  onBluetoothStateChange,
  requestPermission,
  useBluetoothPermission,
  useBluetoothState,
} from './adapter';
export { getDevice } from './device';
export { BleError, type BleErrorCode, isBleError } from './errors';
export { startScan } from './scan';
export type * from './types';
