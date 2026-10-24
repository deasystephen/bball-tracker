/**
 * Box score table component for displaying game statistics
 * Responsive design: scrollable on mobile, full width on tablet/web
 */

import React from 'react';
import { View, StyleSheet, ScrollView, useWindowDimensions } from 'react-native';
import { ThemedText } from '../ThemedText';
import { ThemedView } from '../ThemedView';
import { useTheme } from '../../hooks/useTheme';
import { MAX_FONT_SCALE, spacing } from '../../theme';
import { isTablet, isWeb } from '../../utils/responsive';
import { playerDisplayName } from '../../utils/display-name';
import type { PlayerGameStats, TeamGameStats } from '../../types/stats';
import { i18n, useTranslation } from '../../i18n';

interface BoxScoreTableProps {
  players: PlayerGameStats[];
  teamStats: TeamGameStats;
  showExtendedStats?: boolean;
}

interface ColumnDef {
  key: string;
  /** i18n key of the column header. */
  labelKey: string;
  /** Width at the default text size; it grows with the text up to the cap (#776). */
  width: number;
  getValue: (stats: PlayerGameStats | TeamGameStats) => string | number;
  align?: 'left' | 'center' | 'right';
}

const baseColumns: ColumnDef[] = [
  {
    key: 'player',
    labelKey: 'stats.abbr.player',
    width: 120,
    getValue: (stats) => {
      if ('playerName' in stats) {
        const jersey = stats.jerseyNumber != null ? `#${stats.jerseyNumber} ` : '';
        return `${jersey}${playerDisplayName(stats)}`;
      }
      return i18n.t('stats.abbr.team');
    },
    align: 'left',
  },
  { key: 'pts', labelKey: 'stats.abbr.pts', width: 45, getValue: (s) => s.points, align: 'center' },
  { key: 'reb', labelKey: 'stats.abbr.reb', width: 45, getValue: (s) => s.rebounds, align: 'center' },
  { key: 'ast', labelKey: 'stats.abbr.ast', width: 45, getValue: (s) => s.assists, align: 'center' },
  { key: 'stl', labelKey: 'stats.abbr.stl', width: 45, getValue: (s) => s.steals, align: 'center' },
  { key: 'blk', labelKey: 'stats.abbr.blk', width: 45, getValue: (s) => s.blocks, align: 'center' },
  { key: 'to', labelKey: 'stats.abbr.to', width: 45, getValue: (s) => s.turnovers, align: 'center' },
];

const extendedColumns: ColumnDef[] = [
  { key: 'pf', labelKey: 'stats.abbr.pf', width: 45, getValue: (s) => s.fouls, align: 'center' },
  {
    key: 'fg',
    labelKey: 'stats.abbr.fg',
    width: 60,
    getValue: (s) => `${s.fieldGoalsMade}-${s.fieldGoalsAttempted}`,
    align: 'center',
  },
  {
    key: 'fgp',
    labelKey: 'stats.abbr.fgPct',
    width: 60,
    getValue: (s) => s.fieldGoalPercentage.toFixed(1),
    align: 'center',
  },
  {
    key: '3p',
    labelKey: 'stats.abbr.threes',
    width: 60,
    getValue: (s) => `${s.threePointersMade}-${s.threePointersAttempted}`,
    align: 'center',
  },
  {
    key: '3pp',
    labelKey: 'stats.abbr.threePct',
    width: 60,
    getValue: (s) => s.threePointPercentage.toFixed(1),
    align: 'center',
  },
  {
    key: 'ft',
    labelKey: 'stats.abbr.ft',
    width: 60,
    getValue: (s) => `${s.freeThrowsMade}-${s.freeThrowsAttempted}`,
    align: 'center',
  },
  {
    key: 'ftp',
    labelKey: 'stats.abbr.ftPct',
    width: 60,
    getValue: (s) => s.freeThrowPercentage.toFixed(1),
    align: 'center',
  },
];

export const BoxScoreTable: React.FC<BoxScoreTableProps> = ({
  players,
  teamStats,
  showExtendedStats = true,
}) => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const useFullWidth = isTablet || isWeb;
  // Every row is its own flex row, so a column keeps one width across rows by
  // scaling with the text (capped like the text) rather than growing per cell.
  const widthScale = Math.max(1, Math.min(fontScale, MAX_FONT_SCALE.denseTable));

  const columns = showExtendedStats
    ? [...baseColumns, ...extendedColumns]
    : baseColumns;

  const renderCell = (
    content: string | number,
    column: ColumnDef,
    isHeader: boolean = false,
    isTeamRow: boolean = false
  ) => {
    const textAlign = column.align || 'center';
    const variant = isHeader ? 'caption' : isTeamRow ? 'bodyBold' : 'body';
    const color = isHeader ? 'textSecondary' : 'text';

    return (
      <View
        key={column.key}
        style={[styles.cell, { width: column.width * widthScale }]}
      >
        {/* Data cells never clamp (a value wraps rather than show "12…"); the
            short column labels keep one line (#776). */}
        <ThemedText
          variant={variant}
          color={color}
          style={{ textAlign }}
          numberOfLines={isHeader ? 1 : undefined}
          maxFontSizeMultiplier={MAX_FONT_SCALE.denseTable}
        >
          {content}
        </ThemedText>
      </View>
    );
  };

  const renderRow = (
    stats: PlayerGameStats | TeamGameStats,
    index: number,
    isTeamRow: boolean = false
  ) => {
    const backgroundColor = isTeamRow
      ? colors.primary + '15'
      : index % 2 === 0
      ? 'transparent'
      : colors.border + '30';

    return (
      <View
        key={'playerId' in stats ? stats.playerId : 'team'}
        style={[styles.row, { backgroundColor }]}
      >
        {columns.map((col) =>
          renderCell(col.getValue(stats), col, false, isTeamRow)
        )}
      </View>
    );
  };

  const tableContent = (
    <View style={styles.tableContainer}>
      {/* Header Row */}
      <View style={[styles.row, styles.headerRow, { borderBottomColor: colors.border }]}>
        {columns.map((col) => renderCell(t(col.labelKey), col, true))}
      </View>

      {/* Player Rows */}
      {players.map((player, index) => renderRow(player, index))}

      {/* Team Totals Row */}
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      {renderRow(teamStats, 0, true)}
    </View>
  );

  if (useFullWidth) {
    return (
      <ThemedView variant="card" style={styles.container}>
        {tableContent}
      </ThemedView>
    );
  }

  return (
    <ThemedView variant="card" style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={true}>
        {tableContent}
      </ScrollView>
    </ThemedView>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  tableContainer: {
    minWidth: '100%',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  headerRow: {
    borderBottomWidth: 1,
    paddingBottom: spacing.sm,
  },
  cell: {
    paddingHorizontal: spacing.xs,
    justifyContent: 'center',
    flexShrink: 0,
  },
  divider: {
    height: 1,
    marginVertical: spacing.xs,
  },
});
