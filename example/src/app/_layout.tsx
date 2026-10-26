import * as Ble from '@wekor/react-native-ble';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Button } from '@/components/button';
import { takeBenchRequest } from '@/lib/bench';
import * as compare from '@/lib/compare';
import { runScanFilterTests } from '@/lib/scan-filter-tests';
import { runTests } from '@/lib/test-peripheral/tests';

// Debug logs in development only: they would weigh on release measurements.
Ble.configure({ logLevel: __DEV__ ? 'debug' : 'warn' });

// What a debugger drives over CDP during development: `ble` (the library), `compare` (the comparison with
// react-native-ble-plx: `await compare.run(deviceId)`), `peripheralTests` (`await peripheralTests.run()`, or
// `peripheralTests.run({ only: 'L2CAP' })`) and `scanFilterTests` (`await scanFilterTests.run(console.log)`).
if (__DEV__)
  Object.assign(globalThis, {
    ble: Ble,
    compare,
    peripheralTests: { run: runTests },
    scanFilterTests: { run: runScanFilterTests },
  });

export default function RootLayout() {
  useEffect(() => {
    const query = takeBenchRequest();
    if (query !== undefined) router.push(`/bench?${query}`);
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="bench"
          options={{
            title: 'Measurement',
            presentation: 'modal',
            // Opened by a link, it can be the only screen: then Done leads to the app instead of back.
            headerRight: () => (
              <Button
                small
                tone="plain"
                title="Done"
                onPress={() =>
                  router.canGoBack() ? router.back() : router.replace('/')
                }
              />
            ),
          }}
        />
      </Stack>
    </>
  );
}
