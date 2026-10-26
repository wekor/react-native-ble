import { Platform, StyleSheet } from 'react-native';

/** The colors screens share. */
export const colors = {
  text: '#15181d',
  muted: '#6b7280',
  faint: '#9ca3af',
  border: '#e2e5ea',
  track: '#e7e9ee',
  background: '#f6f7f9',
  white: '#fff',
  accent: '#2563eb',
  danger: '#dc2626',
  success: '#16a34a',
};

/** A monospaced font on each platform: Android has no Menlo. */
export const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** The text styles screens share. */
export const textStyles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  muted: { fontSize: 13, color: colors.muted },
  mono: { fontFamily: monoFont, fontSize: 12, color: colors.text },
});
