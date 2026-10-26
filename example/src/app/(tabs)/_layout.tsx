import { NativeTabs } from 'expo-router/native-tabs';

export default function TabsLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="(devices)">
        <NativeTabs.Trigger.Label>Devices</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="antenna.radiowaves.left.and.right"
          md="bluetooth_searching"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tests">
        <NativeTabs.Trigger.Label>Tests</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="performance">
        <NativeTabs.Trigger.Label>Performance</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="speedometer" md="speed" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
