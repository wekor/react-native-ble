import { StyleSheet, Text } from 'react-native';
import type { LogLine } from '@/hooks/use-log';
import { Button } from './button';
import { Card } from './card';
import { Label } from './label';
import { Row } from './row';
import { colors, monoFont } from './text';

export const LogView = ({
  lines,
  onClear,
}: {
  lines: LogLine[];
  onClear: () => void;
}) => (
  <Card>
    <Row style={{ justifyContent: 'space-between' }}>
      <Label text="Log" />
      <Button title="Clear" tone="plain" small onPress={onClear} />
    </Row>
    {lines.map((line) => (
      <Text
        key={line.id}
        selectable
        style={[
          styles.line,
          line.tone === 'error' && { color: colors.danger },
          line.tone === 'rx' && { color: colors.success },
          line.tone === 'tx' && { color: colors.accent },
        ]}
      >
        {line.time} {line.text}
      </Text>
    ))}
  </Card>
);

const styles = StyleSheet.create({
  line: { fontFamily: monoFont, fontSize: 11, color: colors.text },
});
