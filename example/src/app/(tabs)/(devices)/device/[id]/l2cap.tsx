import type { L2capChannel } from '@wekor/react-native-ble';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Field } from '@/components/field';
import { Label } from '@/components/label';
import { Screen } from '@/components/screen';
import { textStyles } from '@/components/text';
import { useTestPeripheral } from '@/hooks/use-test-peripheral';
import { errorText } from '@/lib/errors';
import { bytesToText, textToBytes } from '@/lib/text';

/** Opens the peripheral's L2CAP channel, which echoes what it receives; closes it when the screen goes. */
export default function L2capRoute() {
  const { peripheral } = useTestPeripheral();
  const [channel, setChannel] = useState<L2capChannel>();
  const [text, setText] = useState('Hello over L2CAP');
  const [received, setReceived] = useState<string[]>([]);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    if (!channel) return;
    const offData = channel.onData((value) =>
      setReceived((previous) => [bytesToText(value), ...previous].slice(0, 20))
    );
    const offClose = channel.onClose((error) => {
      setStatus(error ? `closed: ${errorText(error)}` : 'closed');
      setChannel(undefined);
    });
    return () => {
      offData();
      offClose();
      // Leaving the screen: nothing is left to show a failure.
      channel.close().catch(() => {});
    };
  }, [channel]);

  // `onClose` reports the outcome; only a failed close needs saying here.
  const close = () =>
    channel?.close().catch((error) => setStatus(errorText(error)));

  const open = async () => {
    try {
      const opened = await peripheral.openChannel();
      setStatus(`open on PSM ${opened.psm}`);
      setChannel(opened);
    } catch (error) {
      setStatus(errorText(error));
    }
  };

  return (
    <Screen>
      <Card>
        <Label text="Channel" />
        {status && <Text style={textStyles.muted}>{status}</Text>}
        {channel ? (
          <Button title="Close" tone="danger" onPress={close} />
        ) : (
          <Button title="Open" onPress={open} />
        )}
      </Card>
      {channel && (
        <Card>
          <Label text="Send" />
          <Field value={text} onChangeText={setText} />
          <Button
            title="Send"
            onPress={() =>
              channel
                .write(textToBytes(text))
                .catch((error) => setStatus(errorText(error)))
            }
          />
        </Card>
      )}
      {received.length > 0 && (
        <Card>
          <Label text="Echoed back" />
          {received.map((line, i) => (
            <Text key={i} style={textStyles.mono}>
              {line}
            </Text>
          ))}
        </Card>
      )}
    </Screen>
  );
}
