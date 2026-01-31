/**
 * 2x2 grid of shot buttons for stat tracking
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';

interface ShotButtonsProps {
  onShot: (points: 2 | 3, made: boolean) => void;
  disabled?: boolean;
}

const { width: screenWidth } = Dimensions.get('window');
const buttonWidth = (screenWidth - spacing.md * 3) / 2;
const buttonHeight = 50; // Fixed smaller height

export const ShotButtons: React.FC<ShotButtonsProps> = ({
  onShot,
  disabled = false,
}) => {
  const { colors } = useTheme();

  const handlePress = (points: 2 | 3, made: boolean) => {
    if (!disabled) {
      onShot(points, made);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* 2PT Made */}
        <TouchableOpacity
          style={[
            styles.button,
            {
              backgroundColor: disabled
                ? colors.backgroundSecondary
                : colors.success,
              width: buttonWidth,
              height: buttonHeight,
            },
          ]}
          onPress={() => handlePress(2, true)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <ThemedText variant="bodyBold" style={styles.buttonTextWhite}>
            2PT MADE
          </ThemedText>
        </TouchableOpacity>

        {/* 2PT Miss */}
        <TouchableOpacity
          style={[
            styles.button,
            {
              backgroundColor: disabled
                ? colors.backgroundSecondary
                : colors.error,
              width: buttonWidth,
              height: buttonHeight,
            },
          ]}
          onPress={() => handlePress(2, false)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <ThemedText variant="bodyBold" style={styles.buttonTextWhite}>
            2PT MISS
          </ThemedText>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        {/* 3PT Made */}
        <TouchableOpacity
          style={[
            styles.button,
            {
              backgroundColor: disabled
                ? colors.backgroundSecondary
                : colors.success,
              width: buttonWidth,
              height: buttonHeight,
            },
          ]}
          onPress={() => handlePress(3, true)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <ThemedText variant="bodyBold" style={styles.buttonTextWhite}>
            3PT MADE
          </ThemedText>
        </TouchableOpacity>

        {/* 3PT Miss */}
        <TouchableOpacity
          style={[
            styles.button,
            {
              backgroundColor: disabled
                ? colors.backgroundSecondary
                : colors.error,
              width: buttonWidth,
              height: buttonHeight,
            },
          ]}
          onPress={() => handlePress(3, false)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <ThemedText variant="bodyBold" style={styles.buttonTextWhite}>
            3PT MISS
          </ThemedText>
        </TouchableOpacity>
      </View>

      {disabled && (
        <View style={styles.disabledOverlay}>
          <ThemedText variant="caption" color="textTertiary">
            Select a player first
          </ThemedText>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    position: 'relative',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  button: {
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonTextWhite: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  disabledOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.1)',
    borderRadius: 12,
    margin: spacing.md,
  },
});
