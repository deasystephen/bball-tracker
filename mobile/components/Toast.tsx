/**
 * Toast notification system with slide-in animation and swipe-to-dismiss
 */

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Dimensions,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
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
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(-100);
  const translateX = useSharedValue(0);
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
    translateY.value = withTiming(-100, { duration: 250 });
    opacity.value = withTiming(0, { duration: 250 }, () => {
      runOnJS(onDismiss)(toast.id);
    });
  }, [toast.id, onDismiss, translateY, opacity]);

  // Animate in on mount
  React.useEffect(() => {
    translateY.value = withTiming(0, {
      duration: 350,
      easing: Easing.out(Easing.back(1.2)),
    });
    opacity.value = withTiming(1, { duration: 300 });

    // Auto-dismiss
    dismissTimeoutRef.current = setTimeout(dismiss, toast.duration);

    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, [dismiss, toast.duration, translateY, opacity]);

  const panGesture = Gesture.Pan()
    .onUpdate((event) => {
      if (event.translationY < 0) {
        translateY.value = event.translationY;
      }
      translateX.value = event.translationX;
    })
    .onEnd((event) => {
      if (event.translationY < -50 || Math.abs(event.translationX) > 100) {
        translateY.value = withTiming(-200, { duration: 200 });
        opacity.value = withTiming(0, { duration: 200 }, () => {
          runOnJS(onDismiss)(toast.id);
        });
      } else {
        translateY.value = withTiming(0, { duration: 200 });
        translateX.value = withTiming(0, { duration: 200 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { translateX: translateX.value },
    ],
    opacity: opacity.value,
  }));

  const toastColor = getToastColor();
  const screenWidth = Dimensions.get('window').width;

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View
        style={[
          styles.toast,
          {
            top: insets.top + spacing.sm,
            width: screenWidth - spacing.md * 2,
            left: spacing.md,
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
    </GestureDetector>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback(
    (message: string, type: ToastType = 'success', duration: number = DEFAULT_DURATION) => {
      const id = Date.now().toString() + Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, message, type, duration }]);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <View style={styles.container} pointerEvents="box-none">
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
  },
  toast: {
    position: 'absolute',
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
