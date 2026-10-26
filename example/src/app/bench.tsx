import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { BenchResultView } from '@/components/bench-result';
import { Card } from '@/components/card';
import { Label } from '@/components/label';
import { Screen } from '@/components/screen';
import { textStyles } from '@/components/text';
import { type BenchParams, type BenchResult, runBench } from '@/lib/bench';

/** Opened by `bleexample://bench?kind=...` on release builds, which have no debugger: runs it and shows the result. */
export default function BenchRoute() {
  const params = useLocalSearchParams<BenchParams>();
  const [result, setResult] = useState<BenchResult>();
  const key = JSON.stringify(params);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `params`, a new object each render.
  useEffect(() => {
    let current = true;
    setResult(undefined);
    runBench(params).then((value) => current && setResult(value));
    return () => {
      current = false;
    };
  }, [key]);

  return (
    <Screen>
      <Card>
        <Label text={params.kind ?? 'throughput'} />
        {result ? (
          <BenchResultView result={result} />
        ) : (
          // Static on purpose: an animation redraws every frame, and that CPU would count against the library.
          <Text style={textStyles.muted}>
            Measuring… 10 s of idle CPU first; keep the app in front.
          </Text>
        )}
      </Card>
    </Screen>
  );
}
