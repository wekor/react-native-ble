import { StyleSheet, View } from 'react-native';
import { colors } from './text';

/** Shares of a whole as one bar: `parts` are fractions with their colors; the rest stays empty. */
export const ProgressBar = ({
  parts,
}: {
  parts: { fraction: number; color: string }[];
}) => {
  const filled = parts.reduce((sum, part) => sum + part.fraction, 0);
  return (
    <View style={styles.bar}>
      {parts.map((part) => (
        <View
          key={part.color}
          style={{ flex: part.fraction, backgroundColor: part.color }}
        />
      ))}
      <View style={{ flex: Math.max(0, 1 - filled) }} />
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: colors.track,
  },
});
