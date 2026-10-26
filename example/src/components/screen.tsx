import { ScrollView, StyleSheet } from 'react-native';
import { colors } from './text';

/** A screen's scrolling body; it insets itself under the navigation header and above the tab bar. */
export const Screen = ({ children }: { children: React.ReactNode }) => (
  <ScrollView
    contentInsetAdjustmentBehavior="automatic"
    keyboardShouldPersistTaps="handled"
    style={styles.screen}
    contentContainerStyle={styles.content}
  >
    {children}
  </ScrollView>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12 },
});
