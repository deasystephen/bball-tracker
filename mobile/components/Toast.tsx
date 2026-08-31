/**
 * Toast notification system with slide-in animation and auto-dismiss.
 *
 * Toasts are deliberately non-interactive (`pointerEvents="none"`): the stack
 * renders over the top of the screen, where it covers hero back/edit/delete
 * controls, and an interactive card swallows taps meant for them for its whole
 * 3s lifetime (#464). Taps must pass through; dismissal is time-based only.
 */

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme/spacing';
import { borderRadius } from '../theme/border-radius';
import { shadows } from '../theme/shadows';
import { typography } from '../theme/typography';

type ToastType = 'success' | 'error' | 'info';

interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

const TOAST_ICON: Record<ToastType, keyof typeof Ionicons.glyphMap> = {
  success: 'checkmark-circle',
  error: 'warning',
  info: 'information-circle',
};

const DEFAULT_DURATION = 3000;

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}) {
  const { colors } = useTheme();
  const translateY = useSharedValue(-100);
  const opacity = useSharedValue(0);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getToastColor = () => {
    switch (toast.type) {
      case 'success':
        return colors.success;
      case 'error':
        return colors.error;
      case 'info':
        return colors.info;
    }
  };

  const dismiss = useCallback(() => {
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }
    translateY.set(withTiming(-100, { duration: 250 }));
    opacity.set(
      withTiming(0, { duration: 250 }, () => {
        runOnJS(onDismiss)(toast.id);
      })
    );
  }, [toast.id, onDismiss, translateY, opacity]);

  // Animate in on mount
  React.useEffect(() => {
    translateY.set(withTiming(0, {
      duration: 350,
      easing: Easing.out(Easing.back(1.2)),
    }));
    opacity.set(withTiming(1, { duration: 300 }));

    // Auto-dismiss
    dismissTimeoutRef.current = setTimeout(dismiss, toast.duration);

    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, [dismiss, toast.duration, translateY, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  const toastColor = getToastColor();

  return (
    <Animated.View
      testID={`toast-${toast.type}`}
      accessibilityRole="alert"
      pointerEvents="none"
      style={[
        styles.toast,
        {
          backgroundColor: colors.card,
          borderLeftColor: toastColor,
          ...shadows.lg,
        },
        animatedStyle,
      ]}
    >
      <Ionicons
        name={TOAST_ICON[toast.type]}
        size={22}
        color={toastColor}
        style={styles.icon}
      />
      <Text
        style={[
          styles.message,
          { color: colors.text },
        ]}
        numberOfLines={2}
      >
        {toast.message}
      </Text>
    </Animated.View>
  );
}

/** Upper bound on simultaneously visible toasts; the oldest is dropped first. */
export const MAX_VISIBLE_TOASTS = 3;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const insets = useSafeAreaInsets();

  const showToast = useCallback(
    (message: string, type: ToastType = 'success', duration: number = DEFAULT_DURATION) => {
      const id = Date.now().toString() + Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, message, type, duration }].slice(-MAX_VISIBLE_TOASTS));
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toasts flow as a column (newest at the bottom) so concurrent
          messages stack instead of overlapping at the same offset. */}
      <View
        style={[styles.container, { paddingTop: insets.top + spacing.sm }]}
        pointerEvents="box-none"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    elevation: 9999,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
  },
  icon: {
    marginRight: spacing.sm,
  },
  message: {
    flex: 1,
    ...typography.caption,
  },
});
