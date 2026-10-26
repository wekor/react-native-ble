import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from './text';

/** A tappable row inside a card, with a title, an optional subtitle and a chevron. */
export const ListRow = ({
  title,
  subtitle,
  onPress,
  disabled,
  first,
}: {
  title: string;
  subtitle?: string;
  onPress?: () => void;
  disabled?: boolean;
  /** The first row of its card draws no separator above it. */
  first?: boolean;
}) => (
  <Pressable
    disabled={disabled || !onPress}
    onPress={onPress}
    style={({ pressed }) => [
      styles.row,
      !first && styles.separator,
      pressed && styles.pressed,
      disabled && styles.disabled,
    ]}
  >
    <View style={styles.text}>
      <Text style={styles.title}>{title}</Text>
      {subtitle && <Text style={textStyles.muted}>{subtitle}</Text>}
    </View>
    <Text style={textStyles.muted}>›</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  separator: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pressed: { backgroundColor: colors.background },
  disabled: { opacity: 0.4 },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15, color: colors.text },
});
