import { type ConfigPlugin, createRunOncePlugin } from 'expo/config-plugins';
import { withAndroidBle } from './withAndroid';
import { withIosBle } from './withIos';

/** Options for the `@wekor/react-native-ble` config plugin. */
export interface BlePluginProps {
  /** The `NSBluetoothAlwaysUsageDescription` text, or `false` to leave it unset; a generic message by default. */
  bluetoothPermission?: string | false;
  /** Adds the `bluetooth-central` iOS background mode; off by default. */
  backgroundCentral?: boolean;
  /**
   * Declares `BLUETOOTH_SCAN` with `usesPermissionFlags="neverForLocation"` and, unless the app declares it
   * itself, `ACCESS_FINE_LOCATION` only up to Android 11 (API 30); on by default. Off, location is declared for
   * every Android version.
   */
  neverForLocation?: boolean;
}

const withBle: ConfigPlugin<BlePluginProps> = (config, props = {}) => {
  config = withIosBle(config, props);
  config = withAndroidBle(config, props);
  return config;
};

export default createRunOncePlugin(withBle, '@wekor/react-native-ble');
