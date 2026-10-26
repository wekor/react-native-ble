import { useState } from 'react';
import { Text } from 'react-native';
import { BenchResultView } from '@/components/bench-result';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Label } from '@/components/label';
import { Screen } from '@/components/screen';
import { textStyles } from '@/components/text';
import { type BenchResult, runBench } from '@/lib/bench';

const measurements = [
  {
    kind: 'bridge',
    title: 'Bridge cost',
    detail:
      'The library without the radio: one native round trip, a sync getter, bytes handed to native.',
  },
  {
    kind: 'scanning',
    title: 'Scanning',
    detail:
      'Nearby devices for 20 s with one scan, then two at once: what reaches JS and the CPU it costs.',
  },
  {
    kind: 'throughput',
    title: 'Throughput',
    detail: 'Notifications in and writes out against the test peripheral.',
  },
  {
    kind: 'latency',
    title: 'Latency',
    detail:
      'Round trips to the test peripheral one at a time, then the same and notifications while JS is busy rendering.',
  },
  {
    kind: 'l2cap',
    title: 'L2CAP',
    detail:
      '1 MB in and out over an L2CAP channel, after the throughput steps on the same connection. Ours only: ble-plx has no L2CAP.',
  },
  {
    kind: 'compare',
    title: 'Operations',
    detail:
      'Connects, reads, subscriptions, state() calls, disconnect and connect races and a scan against the test peripheral, with correctness checks.',
  },
] as const;

/**
 * Each measurement runs ours and react-native-ble-plx side by side after 10 s of idle CPU; L2CAP runs ours only.
 * Debug builds inflate every figure; measure on a release build, opened with `bleexample://bench?kind=...`.
 */
export default function PerformanceRoute() {
  const [results, setResults] = useState<Record<string, BenchResult>>({});
  const [running, setRunning] = useState<string>();

  const run = async (kind: string) => {
    setRunning(kind);
    const result = await runBench({ kind });
    setResults((previous) => ({ ...previous, [kind]: result }));
    setRunning(undefined);
  };

  return (
    <Screen>
      {__DEV__ && (
        <Text style={textStyles.muted}>
          This is a debug build: its figures are inflated. Measure on a release
          build.
        </Text>
      )}
      {measurements.map((measurement) => (
        <Card key={measurement.kind}>
          <Label text={measurement.title} />
          <Text style={textStyles.muted}>{measurement.detail}</Text>
          <Button
            title={
              running === measurement.kind
                ? 'Measuring… (10 s idle first)'
                : 'Run'
            }
            disabled={running !== undefined}
            onPress={() => run(measurement.kind)}
          />
          {results[measurement.kind] && (
            <BenchResultView result={results[measurement.kind]!} />
          )}
        </Card>
      ))}
    </Screen>
  );
}
