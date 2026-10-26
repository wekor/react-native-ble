import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Label } from '@/components/label';
import { Row } from '@/components/row';
import { Screen } from '@/components/screen';
import { colors, textStyles } from '@/components/text';
import { useTestPeripheral } from '@/hooks/use-test-peripheral';
import { errorText } from '@/lib/errors';

type Counts = { received: number; outOfOrder: number; last?: number };

/** Subscribed while the screen is open; asks the peripheral to send and counts what arrives. */
export default function NotificationsRoute() {
  const { peripheral } = useTestPeripheral();
  const [counts, setCounts] = useState<Counts>({ received: 0, outOfOrder: 0 });
  const [error, setError] = useState<string>();
  const started = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(
    () =>
      peripheral.onNotification(
        (sequence) => {
          setElapsed(Date.now() - started.current);
          setCounts((previous) => ({
            received: previous.received + 1,
            // Each burst numbers its values from 0, so a value is in order when it follows the last one.
            outOfOrder:
              previous.outOfOrder +
              (sequence !== 0 && sequence !== (previous.last ?? -1) + 1
                ? 1
                : 0),
            last: sequence,
          }));
        },
        (failure) => setError(errorText(failure))
      ),
    [peripheral]
  );

  const request = async (count: number) => {
    setError(undefined);
    setCounts({ received: 0, outOfOrder: 0 });
    started.current = Date.now();
    try {
      await peripheral.startNotifications(count, 180);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <Screen>
      <Card>
        <Label text="Ask the peripheral to notify" />
        <Row>
          {[10, 100, 1000].map((count) => (
            <Button
              key={count}
              small
              title={`${count}`}
              onPress={() => request(count)}
            />
          ))}
        </Row>
        {error && <Text style={{ color: colors.danger }}>{error}</Text>}
      </Card>
      <Card>
        <Label text="Received" />
        <Text style={textStyles.title}>{counts.received}</Text>
        <Text style={textStyles.muted}>
          last #{counts.last ?? '–'} · {counts.outOfOrder} out of order
          {counts.received > 0 ? ` · ${elapsed} ms` : ''}
        </Text>
      </Card>
    </Screen>
  );
}
