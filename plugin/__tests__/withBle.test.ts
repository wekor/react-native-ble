import { expect, test } from 'bun:test';
import type { AndroidConfig } from 'expo/config-plugins';
import { setBleManifestPermissions } from '../src/withAndroid';
import { setBleInfoPlist } from '../src/withIos';

const emptyManifest = (): AndroidConfig.Manifest.AndroidManifest => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    queries: [],
  },
});

const permissions = (
  manifest: AndroidConfig.Manifest.AndroidManifest
): Record<string, Record<string, string | undefined>> =>
  Object.fromEntries(
    (manifest.manifest['uses-permission'] ?? []).map(({ $ }) => {
      const { 'android:name': name, ...attributes } = $;
      return [name.replace('android.permission.', ''), attributes];
    })
  );

test('the Info.plist gets the default usage description and no background mode', () => {
  expect(setBleInfoPlist({}, {})).toEqual({
    NSBluetoothAlwaysUsageDescription: 'Allow $(PRODUCT_NAME) to use Bluetooth',
  });
});

test('the Info.plist keeps existing background modes when adding bluetooth-central', () => {
  const plist = setBleInfoPlist(
    { UIBackgroundModes: ['audio', 'bluetooth-central'] },
    { bluetoothPermission: 'Custom', backgroundCentral: true }
  );
  expect(plist).toEqual({
    NSBluetoothAlwaysUsageDescription: 'Custom',
    UIBackgroundModes: ['audio', 'bluetooth-central'],
  });
});

test('bluetoothPermission false leaves the usage description unset', () => {
  expect(setBleInfoPlist({}, { bluetoothPermission: false })).toEqual({});
});

test('the manifest declares the Android 12 permissions and the legacy ones up to API 30', () => {
  const manifest = setBleManifestPermissions(emptyManifest(), {});
  expect(manifest.manifest.$['xmlns:tools']).toBe(
    'http://schemas.android.com/tools'
  );
  expect(permissions(manifest)).toEqual({
    BLUETOOTH_SCAN: {
      'android:usesPermissionFlags': 'neverForLocation',
      'tools:targetApi': 's',
    },
    BLUETOOTH_CONNECT: {},
    BLUETOOTH: { 'android:maxSdkVersion': '30' },
    BLUETOOTH_ADMIN: { 'android:maxSdkVersion': '30' },
    ACCESS_FINE_LOCATION: { 'android:maxSdkVersion': '30' },
  });
});

test('neverForLocation false declares BLUETOOTH_SCAN without flags and location on every version', () => {
  const manifest = setBleManifestPermissions(emptyManifest(), {
    neverForLocation: false,
  });
  expect(permissions(manifest).BLUETOOTH_SCAN).toEqual({});
  expect(permissions(manifest).ACCESS_FINE_LOCATION).toEqual({});
});

test('neverForLocation false lifts the API 30 limit of an earlier run', () => {
  const manifest = setBleManifestPermissions(
    setBleManifestPermissions(emptyManifest(), {}),
    { neverForLocation: false }
  );
  expect(permissions(manifest).ACCESS_FINE_LOCATION).toEqual({});
});

test('running the plugin again does not duplicate permissions', () => {
  const manifest = setBleManifestPermissions(
    setBleManifestPermissions(emptyManifest(), {}),
    {}
  );
  expect(manifest.manifest['uses-permission']).toHaveLength(5);
});

test('an existing permission is updated in place', () => {
  const manifest = emptyManifest();
  manifest.manifest['uses-permission'] = [
    { $: { 'android:name': 'android.permission.BLUETOOTH' } },
  ];
  setBleManifestPermissions(manifest, {});
  expect(manifest.manifest['uses-permission']).toHaveLength(5);
  expect(permissions(manifest).BLUETOOTH).toEqual({
    'android:maxSdkVersion': '30',
  });
});

test('location the app declares itself keeps working on every version', () => {
  const manifest = emptyManifest();
  manifest.manifest['uses-permission'] = [
    { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } },
  ];
  setBleManifestPermissions(manifest, {});
  expect(manifest.manifest['uses-permission']).toHaveLength(5);
  expect(permissions(manifest).ACCESS_FINE_LOCATION).toEqual({});
});
