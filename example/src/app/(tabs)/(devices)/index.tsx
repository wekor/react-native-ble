import { type ScanResult, startScan } from '@wekor/react-native-ble';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { BluetoothStatus } from '@/components/bluetooth-status';
import { Card } from '@/components/card';
import { Label } from '@/components/label';
import { Row } from '@/components/row';
import { Screen } from '@/components/screen';
import { textStyles } from '@/components/text';
import { SERVICE } from '@/lib/test-peripheral/protocol';

/** Scans for test peripherals while the screen is in front; tapping one opens it. */
export default function DevicesRoute() {
  const [found, setFound] = useState<Map<string, ScanResult>>(new Map());

  useFocusEffect(
    useCallback(
      () =>
        startScan({
          services: [SERVICE],
          onFound: (result) =>
            setFound((previous) =>
              new Map(previous).set(result.device.id, result)
            ),
        }),
      []
    )
  );

  return (
    <Screen>
      <BluetoothStatus />
      <Label text="Test peripherals nearby" />
      {found.size === 0 && (
        <Text style={textStyles.muted}>
          Scanning… Start one on a Mac with example/scripts/test-peripheral.sh.
        </Text>
      )}
      {[...found.values()].map((result) => (
        <Pressable
          key={result.device.id}
          onPress={() =>
            router.push({
              pathname: '/device/[id]',
              params: { id: result.device.id },
            })
          }
        >
          <Card>
            <Row style={styles.header}>
              <Text style={textStyles.title}>
                {result.device.name ?? 'Test peripheral'}
              </Text>
              <Text style={textStyles.mono}>{result.rssi} dBm</Text>
            </Row>
            <Text style={textStyles.mono}>{result.device.id}</Text>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { justifyContent: 'space-between' },
});
