import { Stack } from 'expo-router';

export default function DevicesLayout() {
  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{ title: 'Devices', headerLargeTitle: true }}
      />
      <Stack.Screen name="device/[id]/index" options={{ title: 'Device' }} />
      <Stack.Screen
        name="device/[id]/read-write"
        options={{ title: 'Read & write' }}
      />
      <Stack.Screen
        name="device/[id]/notifications"
        options={{ title: 'Notifications' }}
      />
      <Stack.Screen
        name="device/[id]/file-transfer"
        options={{ title: 'File transfer' }}
      />
      <Stack.Screen name="device/[id]/l2cap" options={{ title: 'L2CAP' }} />
    </Stack>
  );
}
