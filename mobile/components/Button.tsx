/**
 * Themed Button component with gradient and press animation
 */

import React from 'react';
import {
  Pressable,
  PressableProps,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  StyleProp,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { borderRadius } from '../theme/border-radius';
import { getResponsiveValue } from '../utils/responsive';

interface ButtonProps extends Omit<PressableProps, 'style'> {
  title: string;
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost' | 'accent';
  size?: 'small' | 'medium' | 'large';
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export const Button: React.FC<ButtonProps> = ({
  title,
  variant = 'primary',
  size = 'medium',
  loading = false,
  fullWidth = false,
  disabled,
  style,
  ...props
}) => {
  const { colors } = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const getTextColor = () => {
    if (disabled) return colors.textTertiary;
    switch (variant) {
      case 'primary':
      case 'danger':
      case 'accent':
        return colors.textInverse;
      case 'secondary':
        return colors.text;
      case 'outline':
        return colors.primary;
      case 'ghost':
        return colors.primary;
      default:
        return colors.textInverse;
    }
  };

  const getPadding = () => {
    const phonePadding = size === 'small' ? 8 : size === 'large' ? 16 : 12;
    const tabletPadding = size === 'small' ? 12 : size === 'large' ? 20 : 16;
    return getResponsiveValue(phonePadding, tabletPadding);
  };

  const getFontSize = () => {
    return size === 'small' ? 14 : size === 'large' ? 18 : 16;
  };

  const useGradient = variant === 'primary' || variant === 'accent';

  const getBackgroundColor = (): string => {
    if (disabled) return colors.border;
    switch (variant) {
      case 'secondary':
        return colors.backgroundSecondary;
      case 'danger':
        return colors.error;
      case 'outline':
      case 'ghost':
        return 'transparent';
      default:
        return colors.primary;
    }
  };

  const getGradientColors = (): [string, string] => {
    if (variant === 'accent') {
      return [colors.accent, colors.accentDark];
    }
    return [colors.primary, colors.primaryDark];
  };

  const getBorderStyle = (): ViewStyle => {
    if (variant === 'outline') {
      return {
        borderWidth: 1,
        borderColor: disabled ? colors.border : colors.primary,
      };
    }
    return {};
  };

  const paddingValue = getPadding();
  const buttonStyle: ViewStyle = {
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: paddingValue,
    paddingHorizontal: paddingValue * 1.5,
    width: fullWidth ? '100%' : 'auto',
    opacity: disabled ? 0.6 : 1,
    ...getBorderStyle(),
    ...(useGradient ? {} : { backgroundColor: getBackgroundColor() }),
  };

  const content = loading ? (
    <ActivityIndicator color={getTextColor()} size="small" />
  ) : (
    <ThemedText
      variant={size === 'small' ? 'captionBold' : 'bodyBold'}
      style={{
        color: getTextColor(),
        fontSize: getFontSize(),
        letterSpacing: 0.3,
      }}
    >
      {title}
    </ThemedText>
  );

  if (useGradient && !disabled) {
    return (
      <AnimatedPressable
        style={[animatedStyle, style as ViewStyle]}
        disabled={disabled || loading}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="button"
        accessibilityLabel={loading ? `${title}, loading` : title}
        accessibilityState={{ disabled: disabled || loading }}
        {...props}
      >
        <LinearGradient
          colors={getGradientColors()}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={buttonStyle}
        >
          {content}
        </LinearGradient>
      </AnimatedPressable>
    );
  }

  return (
    <AnimatedPressable
      style={[animatedStyle, buttonStyle, style as ViewStyle]}
      disabled={disabled || loading}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityLabel={loading ? `${title}, loading` : title}
      accessibilityState={{ disabled: disabled || loading }}
      {...props}
    >
      {content}
    </AnimatedPressable>
  );
};
