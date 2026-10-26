import { Stack } from 'expo-router';

export default function PerformanceLayout() {
  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{ title: 'Performance', headerLargeTitle: true }}
      />
    </Stack>
  );
}
