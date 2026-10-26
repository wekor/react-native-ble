import { Stack } from 'expo-router';

export default function TestsLayout() {
  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{ title: 'Tests', headerLargeTitle: true }}
      />
    </Stack>
  );
}
