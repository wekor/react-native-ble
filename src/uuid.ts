import { BleError } from './errors';

const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const HEX = /^[0-9a-f]+$/;

/** Converts a 16-, 32- or 128-bit UUID string in any case to the lowercase 128-bit form native uses. */
export const normalizeUuid = (uuid: string) => {
  const lower = uuid.trim().toLowerCase();
  const compact = lower.replace(/-/g, '');
  if (HEX.test(compact)) {
    if (compact.length === 4) return `0000${compact}${BASE_UUID_SUFFIX}`;
    if (compact.length === 8) return `${compact}${BASE_UUID_SUFFIX}`;
    if (compact.length === 32) {
      return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
    }
  }
  throw new BleError('invalid-argument', `Not a Bluetooth UUID: '${uuid}'`);
};
