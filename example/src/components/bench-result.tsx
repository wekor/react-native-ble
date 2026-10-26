import { Text } from 'react-native';
import { type BenchResult, summarize } from '@/lib/bench';
import { ResultTable } from './result-table';
import { colors, textStyles } from './text';

/** A finished measurement: its error, or its table with the idle CPU it is measured against. */
export const BenchResultView = ({ result }: { result: BenchResult }) => {
  if (result.error)
    return <Text style={{ color: colors.danger }}>{result.error}</Text>;
  const table = summarize(result);
  return (
    <>
      <ResultTable columns={table.columns} rows={table.rows} />
      {table.idleCpu && (
        <Text style={textStyles.muted}>
          Idle CPU {table.idleCpu} of one core, included in every CPU figure.
        </Text>
      )}
    </>
  );
};
