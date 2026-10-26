import { useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Label } from '@/components/label';
import { ProgressBar } from '@/components/progress-bar';
import { Row } from '@/components/row';
import { Screen } from '@/components/screen';
import { colors, textStyles } from '@/components/text';
import { useTestPeripheral } from '@/hooks/use-test-peripheral';
import { errorText } from '@/lib/errors';

const sizes = [10, 100, 500];

/** Sends a generated file of the chosen size; the peripheral checks every byte by CRC-32. */
export default function FileTransferRoute() {
  const { peripheral } = useTestPeripheral();
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [result, setResult] = useState<string>();
  const [sending, setSending] = useState(false);

  const send = async (kilobytes: number) => {
    const file = new Uint8Array(kilobytes * 1024).map(
      (_, i) => (i * 31) & 0xff
    );
    setSending(true);
    setResult(undefined);
    const started = Date.now();
    try {
      await peripheral.sendFile(file, (sent, total) =>
        setProgress({ sent, total })
      );
      const seconds = (Date.now() - started) / 1000;
      setResult(
        `${kilobytes} KB in ${seconds.toFixed(1)} s, ${(kilobytes / seconds).toFixed(1)} KB/s, checksum matches`
      );
    } catch (error) {
      setResult(errorText(error));
    }
    setSending(false);
  };

  return (
    <Screen>
      <Card>
        <Label text="Send a file" />
        <Row>
          {sizes.map((size) => (
            <Button
              key={size}
              small
              title={`${size} KB`}
              disabled={sending}
              onPress={() => send(size)}
            />
          ))}
        </Row>
        {progress.total > 0 && (
          <>
            <ProgressBar
              parts={[
                {
                  fraction: progress.sent / progress.total,
                  color: colors.accent,
                },
              ]}
            />
            <Text style={textStyles.muted}>
              {Math.round(progress.sent / 1024)} of{' '}
              {Math.round(progress.total / 1024)} KB
            </Text>
          </>
        )}
        {result && <Text style={textStyles.mono}>{result}</Text>}
      </Card>
    </Screen>
  );
}
