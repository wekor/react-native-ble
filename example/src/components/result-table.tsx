import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from './text';

/** A table of text: a header row, then rows of cells. Scrolls sideways when it is wider than the screen. */
export const ResultTable = ({
  columns,
  rows,
}: {
  columns: string[];
  rows: string[][];
}) => (
  <ScrollView horizontal>
    <View>
      {[columns, ...rows].map((cells, row) => (
        <View key={row} style={[styles.row, row === 0 && styles.header]}>
          {cells.map((cell, column) => (
            <Text
              key={column}
              selectable
              style={[
                styles.cell,
                column === 0 && styles.first,
                row === 0 && styles.headerText,
              ]}
            >
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  </ScrollView>
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  header: { borderBottomColor: colors.text },
  cell: {
    width: 110,
    paddingVertical: 6,
    paddingRight: 8,
    fontSize: 12,
    color: colors.text,
  },
  first: { width: 190 },
  headerText: { fontWeight: '600', color: colors.muted },
});
