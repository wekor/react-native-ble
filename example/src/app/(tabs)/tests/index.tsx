import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Label } from '@/components/label';
import { LogView } from '@/components/log-view';
import { ProgressBar } from '@/components/progress-bar';
import { Row } from '@/components/row';
import { Screen } from '@/components/screen';
import { colors, monoFont, textStyles } from '@/components/text';
import { useLog } from '@/hooks/use-log';
import { errorText } from '@/lib/errors';
import { runScanFilterTests } from '@/lib/scan-filter-tests';
import { runTests, tests } from '@/lib/test-peripheral/tests';

type Status = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
type TestState = { status: Status; ms?: number; detail?: string };

const groups = [...new Set(tests.map((test) => test.group))];

const formatMs = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

const finished = {
  passed: { color: colors.success, glyph: '✓' },
  failed: { color: colors.danger, glyph: '✕' },
  skipped: { color: colors.faint, glyph: '–' },
};

const StatusIcon = ({ status }: { status: Status }) => {
  if (status === 'running')
    return <ActivityIndicator size="small" style={styles.icon} />;
  if (status === 'pending')
    return <View style={[styles.icon, styles.pending]} />;
  const { color, glyph } = finished[status];
  return (
    <View style={[styles.icon, { backgroundColor: color }]}>
      <Text style={styles.iconText}>{glyph}</Text>
    </View>
  );
};

/** The test peripheral's suite, one row per test; tapping a row runs that test alone. */
export default function TestsRoute() {
  const [states, setStates] = useState<Record<string, TestState>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [scanFiltersRunning, setScanFiltersRunning] = useState(false);
  const log = useLog();

  const set = (name: string, state: TestState) =>
    setStates((previous) => ({ ...previous, [name]: state }));

  const run = async (name?: string) => {
    setRunning(true);
    setError(undefined);
    for (const test of tests)
      if (!name || test.name === name) set(test.name, { status: 'pending' });
    try {
      await runTests({
        name,
        onStart: (name) => set(name, { status: 'running' }),
        onResult: ({ name, ok, skipped, ms, detail }) =>
          set(name, {
            status: skipped ? 'skipped' : ok ? 'passed' : 'failed',
            ms,
            detail,
          }),
      });
    } catch (failure) {
      setError(errorText(failure));
    }
    setRunning(false);
  };

  const runScanFilters = async () => {
    setScanFiltersRunning(true);
    await runScanFilterTests(log.add);
    setScanFiltersRunning(false);
  };

  const statuses = tests.map((test) => states[test.name]?.status);
  const passed = statuses.filter((status) => status === 'passed').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const skipped = statuses.filter((status) => status === 'skipped').length;

  return (
    <Screen>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={textStyles.title}>Test peripheral</Text>
            <Text style={[textStyles.muted, error && { color: colors.danger }]}>
              {error ??
                `${passed} passed · ${failed} failed${skipped ? ` · ${skipped} skipped` : ''} · ${tests.length} tests`}
            </Text>
          </View>
          <Button
            title={running ? 'Running…' : 'Run all'}
            disabled={running}
            onPress={() => run()}
          />
        </Row>
        <ProgressBar
          parts={[
            { fraction: passed / tests.length, color: colors.success },
            { fraction: failed / tests.length, color: colors.danger },
          ]}
        />
      </Card>

      {groups.map((group) => (
        <View key={group} style={{ gap: 6 }}>
          <Label text={group} />
          <Card style={{ padding: 0, gap: 0 }}>
            {tests
              .filter((test) => test.group === group)
              .map((test, i) => {
                const state = states[test.name] ?? { status: 'pending' };
                return (
                  <Pressable
                    key={test.name}
                    disabled={running}
                    onPress={() => run(test.name)}
                    style={[styles.row, i > 0 && styles.separator]}
                  >
                    <StatusIcon status={state.status} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.name}>{test.name}</Text>
                      {state.detail && (
                        <Text
                          selectable
                          style={[
                            styles.detail,
                            state.status === 'failed' && {
                              color: colors.danger,
                            },
                          ]}
                        >
                          {state.detail}
                        </Text>
                      )}
                    </View>
                    {state.ms !== undefined && (
                      <Text style={styles.detail}>{formatMs(state.ms)}</Text>
                    )}
                  </Pressable>
                );
              })}
          </Card>
        </View>
      ))}

      <Card>
        <Label text="Scan filters" />
        <Text style={textStyles.muted}>
          Picks a nearby device, builds filters from its advertisement and
          re-checks every result.
        </Text>
        <Button
          title={scanFiltersRunning ? 'Running…' : 'Run scan filter tests'}
          disabled={scanFiltersRunning}
          onPress={runScanFilters}
        />
      </Card>
      {log.lines.length > 0 && (
        <LogView lines={log.lines} onClear={log.clear} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  separator: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  icon: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pending: { borderWidth: 1.5, borderColor: colors.border },
  iconText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  name: { fontSize: 15, color: colors.text },
  detail: { fontFamily: monoFont, fontSize: 11, color: colors.muted },
});
