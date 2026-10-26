import { StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { colors } from './text';

export const Field = (props: TextInputProps) => (
  <TextInput
    autoCapitalize="none"
    autoCorrect={false}
    placeholderTextColor={colors.muted}
    {...props}
    style={[styles.field, props.style]}
  />
);

const styles = StyleSheet.create({
  field: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    // A fixed height rather than vertical padding: Android sizes the box to the font's metrics, and some system
    // fonts (MIUI's) are taller than the padding leaves room for, so the text was clipped.
    height: 40,
    paddingHorizontal: 10,
    paddingVertical: 0,
    textAlignVertical: 'center',
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.white,
  },
});
