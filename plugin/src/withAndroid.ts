import {
  type AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
} from 'expo/config-plugins';
import type { BlePluginProps } from './index';

export function setBleManifestPermissions(
  androidManifest: AndroidConfig.Manifest.AndroidManifest,
  { neverForLocation = true }: BlePluginProps
): AndroidConfig.Manifest.AndroidManifest {
  const manifest = androidManifest.manifest;
  manifest.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';
  manifest['uses-permission'] ??= [];
  const permissions = manifest['uses-permission'];
  const find = (name: string) =>
    permissions.find(
      (permission) =>
        permission.$['android:name'] === `android.permission.${name}`
    );
  const add = (name: string, attributes: Record<string, string> = {}) => {
    const existing = find(name);
    if (existing) Object.assign(existing.$, attributes);
    else
      permissions.push({
        $: { 'android:name': `android.permission.${name}`, ...attributes },
      });
  };
  add(
    'BLUETOOTH_SCAN',
    neverForLocation
      ? {
          'android:usesPermissionFlags': 'neverForLocation',
          'tools:targetApi': 's',
        }
      : {}
  );
  add('BLUETOOTH_CONNECT');
  add('BLUETOOTH', { 'android:maxSdkVersion': '30' });
  add('BLUETOOTH_ADMIN', { 'android:maxSdkVersion': '30' });
  // Scanning needs location only up to Android 11, unless the app derives location from scan results; a
  // declaration the app made itself is left as it is, since the app may need location on any version.
  const location = find('ACCESS_FINE_LOCATION');
  if (!neverForLocation) {
    if (location)
      delete (location.$ as Record<string, string>)['android:maxSdkVersion'];
    else add('ACCESS_FINE_LOCATION');
  } else if (!location) {
    add('ACCESS_FINE_LOCATION', { 'android:maxSdkVersion': '30' });
  }
  return androidManifest;
}

export const withAndroidBle: ConfigPlugin<BlePluginProps> = (config, props) =>
  withAndroidManifest(config, (config) => {
    config.modResults = setBleManifestPermissions(config.modResults, props);
    return config;
  });
