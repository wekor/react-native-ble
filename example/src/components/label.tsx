import { StyleSheet, Text } from 'react-native';
import { colors } from './text';

/** A small uppercase heading for a card or section. */
export const Label = ({ text }: { text: string }) => (
  <Text style={styles.label}>{text}</Text>
);

const styles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
  },
});
