/**
 * A season record as coloured numbers, each with its W / L / T caption, so the
 * outcome never rests on colour alone (#778). Used by the Stats tab card and
 * Team Stats.
 *
 * By default the row is one accessible element read as a sentence
 * ("Season record: 7 wins, 7 losses, 1 tie"). Inside a pressable that carries
 * its own label (the Stats tab card), pass `labelled={false}` so the row adds
 * no second focusable element.
 */

import React from 'react';
import { View, StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { spacing } from '../../theme';
import { describeRecord, getRecordParts, getResultColor } from '../../utils/game-result';

export interface SeasonRecordProps {
  wins: number;
  losses: number;
  ties: number;
  /** Extra style for the numbers, e.g. a larger font. */
  numberStyle?: StyleProp<TextStyle>;
  style?: StyleProp<ViewStyle>;
  /** False when an enclosing pressable carries the spoken label. */
  labelled?: boolean;
  testID?: string;
}

export function SeasonRecord({
  wins,
  losses,
  ties,
  numberStyle,
  style,
  labelled = true,
  testID,
}: SeasonRecordProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <View
      style={[styles.row, style]}
      testID={testID}
      {...(labelled
        ? { accessible: true, accessibilityLabel: describeRecord(t, wins, losses, ties) }
        : {})}
    >
      {getRecordParts(wins, losses, ties).map(({ result, count }, index) => (
        <React.Fragment key={result}>
          {index > 0 && (
            <ThemedText variant="h2" color="textTertiary">
              -
            </ThemedText>
          )}
          <View style={styles.column}>
            <ThemedText
              variant="h1"
              style={[{ color: getResultColor(result, colors) }, numberStyle]}
            >
              {count}
            </ThemedText>
            <ThemedText variant="caption" color="textSecondary">
              {result}
            </ThemedText>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  column: { alignItems: 'center' },
});
