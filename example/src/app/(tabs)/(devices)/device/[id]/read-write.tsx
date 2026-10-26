import { useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Field } from '@/components/field';
import { Label } from '@/components/label';
import { Screen } from '@/components/screen';
import { textStyles } from '@/components/text';
import { useTestPeripheral } from '@/hooks/use-test-peripheral';
import { errorText } from '@/lib/errors';
import { toHex } from '@/lib/hex';
import { bytesToText, textToBytes } from '@/lib/text';

/** Reads and writes: each button is one call on the peripheral, and shows what came back. */
export default function ReadWriteRoute() {
  const { peripheral } = useTestPeripheral();
  const [counter, setCounter] = useState<string>();
  const [pattern, setPattern] = useState<string>();
  const [text, setText] = useState('Hello');
  const [echo, setEcho] = useState<string>();

  /** Runs `action` and shows its result, or its error, through `show`. */
  const run =
    (show: (text: string) => void, action: () => Promise<string>) => () =>
      action().then(show, (error) => show(errorText(error)));

  return (
    <Screen>
      <Card>
        <Label text="Counter" />
        <Text style={textStyles.muted}>Grows by one on every read.</Text>
        <Button
          title="Read"
          onPress={run(setCounter, async () =>
            String(await peripheral.readCounter())
          )}
        />
        {counter !== undefined && (
          <Text style={textStyles.mono}>{counter}</Text>
        )}
      </Card>

      <Card>
        <Label text="Long read" />
        <Text style={textStyles.muted}>
          512 bytes: more than one packet, so the library reads it in parts.
        </Text>
        <Button
          title="Read"
          onPress={run(setPattern, async () => {
            const value = await peripheral.readPattern();
            return `${value.length} bytes: ${toHex(value.subarray(0, 8))} …`;
          })}
        />
        {pattern !== undefined && (
          <Text style={textStyles.mono}>{pattern}</Text>
        )}
      </Card>

      <Card>
        <Label text="Echo" />
        <Text style={textStyles.muted}>
          Writes the text, then reads back what the peripheral kept.
        </Text>
        <Field value={text} onChangeText={setText} />
        <Button
          title="Write and read back"
          onPress={run(setEcho, async () => {
            await peripheral.writeEcho(textToBytes(text));
            return bytesToText(await peripheral.readEcho());
          })}
        />
        {echo !== undefined && <Text style={textStyles.mono}>{echo}</Text>}
      </Card>
    </Screen>
  );
}
