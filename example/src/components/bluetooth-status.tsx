import {
  android,
  useBluetoothPermission,
  useBluetoothState,
} from '@wekor/react-native-ble';
import { Linking, Text } from 'react-native';
import { Button } from './button';
import { Card } from './card';
import { Row } from './row';
import { textStyles } from './text';

/** The adapter's state and permission, with what fixes them. */
export const BluetoothStatus = () => {
  const state = useBluetoothState();
  const [permission, requestPermission] = useBluetoothPermission();
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={textStyles.title}>Bluetooth {state}</Text>
        <Text style={textStyles.muted}>
          permission {permission?.status ?? '…'}
        </Text>
      </Row>
      {permission && !permission.granted && (
        <Button
          title={permission.canAskAgain ? 'Allow Bluetooth' : 'Open settings'}
          onPress={() =>
            permission.canAskAgain
              ? requestPermission()
              : Linking.openSettings()
          }
        />
      )}
      {state === 'off' && android && (
        <Button
          title="Turn on"
          tone="plain"
          onPress={() => android?.requestEnable()}
        />
      )}
    </Card>
  );
};
