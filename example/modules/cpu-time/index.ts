import { requireOptionalNativeModule } from 'expo-modules-core';

/** The app process's CPU time in ms, or undefined where the module isn't built in. */
export const cpuMs = requireOptionalNativeModule<{ cpuMs(): number }>(
  'CpuTime'
)?.cpuMs;
