/**
 * Themed List Item component
 */

import React from 'react';
import {
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  StyleSheet,
} from 'react-native';
import { ThemedText } from './ThemedText';
import { ThemedView } from './ThemedView';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { shadows } from '../theme/shadows';
import { borderRadius } from '../theme/border-radius';
import { getResponsiveValue } from '../utils/responsive';
import { MIN_TOUCH_TARGET } from '../utils/touch-target';

interface ListItemProps extends Omit<TouchableOpacityProps, 'style'> {
  title: string;
  subtitle?: string;
  /**
   * Rendered on the subtitle's line, after it (or alone when there is no
   * subtitle), wrapping to a line of its own when both do not fit. For a
   * status chip that must not take its width from the title (#1095).
   */
  subtitleAccessory?: React.ReactNode;
  /** Lines the title may use before it truncates (default 1). */
  titleNumberOfLines?: number;
  rightElement?: React.ReactNode;
  leftElement?: React.ReactNode;
  onPress?: () => void;
  variant?: 'default' | 'card';
  style?: TouchableOpacityProps['style'];
}

export const ListItem: React.FC<ListItemProps> = ({
  title,
  subtitle,
  subtitleAccessory,
  titleNumberOfLines = 1,
  rightElement,
  leftElement,
  onPress,
  variant = 'default',
  style,
  ...props
}) => {
  const { colors } = useTheme();
  const padding = getResponsiveValue(spacing.md, spacing.lg);
  const paddingVertical = getResponsiveValue(spacing.sm, spacing.md);

  const containerStyle = [
    styles.container,
    {
      paddingHorizontal: padding,
      paddingVertical: paddingVertical,
      backgroundColor: variant === 'card' ? colors.card : 'transparent',
      borderBottomWidth: variant === 'default' ? StyleSheet.hairlineWidth : 0,
      borderBottomColor: colors.border,
      ...(variant === 'card' && {
        borderRadius: borderRadius.md,
        ...shadows.sm,
      }),
    },
    style,
  ];

  const content = (
    <View style={styles.content}>
      {leftElement && <View style={styles.leftElement}>{leftElement}</View>}
      <View style={styles.textContainer}>
        <ThemedText variant="body" numberOfLines={titleNumberOfLines}>
          {title}
        </ThemedText>
        {subtitleAccessory ? (
          <View style={styles.subtitleRow}>
            {subtitle && (
              <ThemedText
                variant="caption"
                color="textSecondary"
                style={styles.subtitleInRow}
                numberOfLines={1}
              >
                {subtitle}
              </ThemedText>
            )}
            {subtitleAccessory}
          </View>
        ) : (
          subtitle && (
            <ThemedText
              variant="caption"
              color="textSecondary"
              style={styles.subtitle}
              numberOfLines={1}
            >
              {subtitle}
            </ThemedText>
          )
        )}
      </View>
      {rightElement && <View style={styles.rightElement}>{rightElement}</View>}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        style={containerStyle}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        {...props}
      >
        {content}
      </TouchableOpacity>
    );
  }

  return (
    <ThemedView style={containerStyle} {...props}>
      {content}
    </ThemedView>
  );
};

const styles = StyleSheet.create({
  container: {
    minHeight: MIN_TOUCH_TARGET, // iOS touch target minimum
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  leftElement: {
    marginRight: spacing.md,
  },
  textContainer: {
    flex: 1,
  },
  subtitle: {
    marginTop: 2,
  },
  subtitleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing.sm,
    rowGap: spacing.xs,
    marginTop: spacing.xs,
  },
  subtitleInRow: {
    flexShrink: 1,
  },
  rightElement: {
    marginLeft: spacing.md,
  },
});
