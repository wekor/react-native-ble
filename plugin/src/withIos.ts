import {
  type ConfigPlugin,
  type InfoPlist,
  withInfoPlist,
} from 'expo/config-plugins';
import type { BlePluginProps } from './index';

const DEFAULT_PERMISSION_MESSAGE = 'Allow $(PRODUCT_NAME) to use Bluetooth';

export function setBleInfoPlist(
  infoPlist: InfoPlist,
  {
    bluetoothPermission = DEFAULT_PERMISSION_MESSAGE,
    backgroundCentral = false,
  }: BlePluginProps
): InfoPlist {
  if (bluetoothPermission !== false)
    infoPlist.NSBluetoothAlwaysUsageDescription = bluetoothPermission;
  if (backgroundCentral) {
    const modes = new Set(infoPlist.UIBackgroundModes ?? []);
    modes.add('bluetooth-central');
    infoPlist.UIBackgroundModes = [...modes];
  }
  return infoPlist;
}

export const withIosBle: ConfigPlugin<BlePluginProps> = (config, props) =>
  withInfoPlist(config, (config) => {
    config.modResults = setBleInfoPlist(config.modResults, props);
    return config;
  });
