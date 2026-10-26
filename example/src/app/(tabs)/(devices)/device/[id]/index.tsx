import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { ListRow } from '@/components/list-row';
import { Row } from '@/components/row';
import { Screen } from '@/components/screen';
import { colors, textStyles } from '@/components/text';
import { useTestPeripheral } from '@/hooks/use-test-peripheral';
import { errorText } from '@/lib/errors';

const features = [
  {
    path: 'read-write',
    title: 'Read & write',
    subtitle: 'A counter, a long read, an echo',
  },
  {
    path: 'notifications',
    title: 'Notifications',
    subtitle: 'Subscribe and count what arrives',
  },
  {
    path: 'file-transfer',
    title: 'File transfer',
    subtitle: 'Chunked writes, checked by CRC-32',
  },
  { path: 'l2cap', title: 'L2CAP', subtitle: 'A channel that echoes' },
] as const;

/** Connects to the test peripheral and leads to what it can do. */
export default function DeviceRoute() {
  const { peripheral, state, disconnectReason } = useTestPeripheral();
  const [error, setError] = useState<string>();
  const { device } = peripheral;
  const connected = state === 'connected';

  const toggle = async () => {
    setError(undefined);
    try {
      await (connected ? peripheral.disconnect() : peripheral.connect());
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: device.name ?? 'Test peripheral' }} />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={textStyles.title}>{state}</Text>
          <Button
            small
            title={connected ? 'Disconnect' : 'Connect'}
            tone={connected ? 'danger' : 'accent'}
            disabled={state === 'connecting' || state === 'disconnecting'}
            onPress={toggle}
          />
        </Row>
        <Text style={textStyles.mono}>{device.id}</Text>
        {connected && (
          <Text style={textStyles.muted}>
            MTU {device.mtu} · {device.services.length} services · writes up to{' '}
            {device.maxWriteLength()} B
          </Text>
        )}
        {error && <Text style={{ color: colors.danger }}>{error}</Text>}
        {!error && disconnectReason && state === 'disconnected' && (
          <Text style={{ color: colors.danger }}>
            Disconnected: {disconnectReason.message}
          </Text>
        )}
      </Card>
      <Card style={{ padding: 0, gap: 0 }}>
        {features.map((feature, i) => (
          <ListRow
            key={feature.path}
            first={i === 0}
            title={feature.title}
            subtitle={feature.subtitle}
            disabled={!connected}
            onPress={() =>
              router.push({
                pathname: `/device/[id]/${feature.path}`,
                params: { id: device.id },
              })
            }
          />
        ))}
      </Card>
    </Screen>
  );
}
