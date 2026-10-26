import { Pressable, StyleSheet, Text } from 'react-native';
import { colors } from './text';

export const Button = ({
  title,
  onPress,
  disabled,
  tone = 'accent',
  small,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'accent' | 'danger' | 'plain';
  small?: boolean;
}) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      styles.button,
      small && styles.small,
      tone === 'plain'
        ? styles.plain
        : {
            backgroundColor: tone === 'danger' ? colors.danger : colors.accent,
          },
      (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 },
    ]}
  >
    <Text
      style={[
        styles.text,
        tone === 'plain' && { color: colors.accent },
        small && styles.smallText,
      ]}
    >
      {title}
    </Text>
  </Pressable>
);

const styles = StyleSheet.create({
  button: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  small: { paddingHorizontal: 10, paddingVertical: 6 },
  plain: { backgroundColor: 'transparent' },
  text: { color: colors.white, fontWeight: '600', fontSize: 15 },
  smallText: { fontSize: 13 },
});
