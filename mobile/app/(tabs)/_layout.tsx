import React, { useCallback, useEffect, useMemo } from 'react';
import { View, TouchableOpacity, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
} from 'react-native-reanimated';
import { useTheme } from '../../hooks/useTheme';
import { TAB_BAR_HEIGHT } from '../../hooks/useTabBarPadding';
import { borderRadius, MAX_FONT_SCALE } from '../../theme';
import { useTranslation } from '../../i18n';
import { log } from '../../services/log';
// expo-router carries its own fork of the tab navigator since SDK 56; the
// `@react-navigation/bottom-tabs` package is no longer installed.
import type { BottomTabBarProps } from 'expo-router/js-tabs';

const TAB_CONFIGS = [
  { name: 'home', icon: 'home', labelKey: 'tabs.home' },
  { name: 'teams', icon: 'people', labelKey: 'tabs.teams' },
  { name: 'games', icon: 'basketball', labelKey: 'tabs.track' },
  { name: 'stats', icon: 'stats-chart', labelKey: 'tabs.stats' },
  { name: 'profile', icon: 'person', labelKey: 'tabs.profile' },
] as const;

const TRACK_INDEX = 2;

function CustomTabBar({ state, navigateToTab }: BottomTabBarProps) {
  const { colors, colorScheme } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const tabWidth = screenWidth / TAB_CONFIGS.length;

  // Map the navigator's focused route to one of the five tabs the bar shows.
  // -1 when the focused route is not one of them (`invitations`, `href: null`):
  // then no tab is selected and the pill is hidden, so every button, Home
  // included, still navigates (#1117).
  const activeRouteName = state.routes[state.index]?.name;
  const activeVisualIndex = TAB_CONFIGS.findIndex((tab) => tab.name === activeRouteName);
  const hasActiveTab = activeVisualIndex >= 0;

  const pillPosition = useSharedValue(Math.max(activeVisualIndex, 0));
  // The pill follows the navigator's state, not the tap: a tab change that
  // comes from `router.replace` or a deep link moves it too (#1117).
  useEffect(() => {
    if (activeVisualIndex < 0) return;
    pillPosition.set(withSpring(activeVisualIndex, { damping: 18, stiffness: 200 }));
  }, [activeVisualIndex, pillPosition]);
  const scale0 = useSharedValue(1);
  const scale1 = useSharedValue(1);
  const scale2 = useSharedValue(1);
  const scale3 = useSharedValue(1);
  const scale4 = useSharedValue(1);
  const scales = useMemo(
    () => [scale0, scale1, scale2, scale3, scale4],
    [scale0, scale1, scale2, scale3, scale4]
  );

  const handlePress = useCallback(
    (index: number, routeKey: string | undefined, isFocused: boolean) => {
      if (!routeKey) {
        // A TAB_CONFIGS name with no route file: the button would be dead.
        log.warn('[TabBar] no route for tab', { index });
        return;
      }
      if (!isFocused) {
        scales[index].set(
          withSequence(
            withSpring(1.15, { damping: 6, stiffness: 300 }),
            withSpring(1, { damping: 8, stiffness: 200 })
          )
        );
        // SDK 58's router fork hands the tab bar `navigateToTab(route.key)`;
        // the `navigation` prop it replaced is gone (#922).
        navigateToTab(routeKey);
      }
    },
    [navigateToTab, scales]
  );

  const pillStyle = useAnimatedStyle(() => {
    return {
      width: tabWidth,
      transform: [{ translateX: pillPosition.value * tabWidth }],
    };
  });

  const iconStyle0 = useAnimatedStyle(() => ({
    transform: [{ scale: scale0.value }],
  }));
  const iconStyle1 = useAnimatedStyle(() => ({
    transform: [{ scale: scale1.value }],
  }));
  const iconStyle2 = useAnimatedStyle(() => ({
    transform: [{ scale: scale2.value }],
  }));
  const iconStyle3 = useAnimatedStyle(() => ({
    transform: [{ scale: scale3.value }],
  }));
  const iconStyle4 = useAnimatedStyle(() => ({
    transform: [{ scale: scale4.value }],
  }));
  const iconStyles = [iconStyle0, iconStyle1, iconStyle2, iconStyle3, iconStyle4];

  return (
    <View style={styles.tabBarOuter}>
      <BlurView
        intensity={80}
        tint={colorScheme === 'dark' ? 'dark' : 'light'}
        style={styles.blurContainer}
      >
        {/* The safe-area inset lives INSIDE the blurred surface so the bar
            runs to the physical bottom edge — padding it outside left a
            transparent strip under the bar where content showed through
            un-blurred. */}
        <View
          style={[
            styles.tabBarInner,
            {
              height: TAB_BAR_HEIGHT + insets.bottom,
              paddingBottom: insets.bottom,
              backgroundColor:
                colorScheme === 'dark'
                  ? 'rgba(13, 17, 23, 0.85)'
                  : 'rgba(255, 255, 255, 0.85)',
              borderTopColor: colors.borderLight,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.pill,
              { backgroundColor: colors.primary + '18', opacity: hasActiveTab ? 1 : 0 },
              pillStyle,
            ]}
            testID="tab-bar-pill"
          />

          {TAB_CONFIGS.map((tab, index) => {
            const isFocused = activeVisualIndex === index;
            const isTrackTab = index === TRACK_INDEX;
            const label = t(tab.labelKey);

            const routeKey = state.routes.find((r) => r.name === tab.name)?.key;

            return (
              <TouchableOpacity
                key={tab.name}
                onPress={() => handlePress(index, routeKey, isFocused)}
                style={styles.tabItem}
                accessibilityRole="button"
                accessibilityState={{ selected: isFocused }}
                accessibilityLabel={
                  isTrackTab ? t('tabs.trackA11y') : t('tabs.tabA11y', { label })
                }
              >
                {isTrackTab ? (
                  <Animated.View
                    style={[
                      styles.trackButton,
                      {
                        backgroundColor: isFocused
                          ? colors.accent
                          : colors.primary,
                      },
                      iconStyles[index],
                    ]}
                  >
                    <Ionicons
                      name={tab.icon as keyof typeof Ionicons.glyphMap}
                      size={26}
                      color="#FFFFFF"
                    />
                  </Animated.View>
                ) : (
                  <Animated.View
                    style={[styles.iconContainer, iconStyles[index]]}
                  >
                    <Ionicons
                      name={
                        (isFocused
                          ? tab.icon
                          : `${tab.icon}-outline`) as keyof typeof Ionicons.glyphMap
                      }
                      size={24}
                      color={
                        isFocused ? colors.primary : colors.tabBarInactive
                      }
                    />
                  </Animated.View>
                )}
                {isFocused && !isTrackTab && (
                  <Animated.Text
                    style={[styles.tabLabel, { color: colors.primary }]}
                    maxFontSizeMultiplier={MAX_FONT_SCALE.fixedControl}
                    // "Estadísticas" is wider than a 64pt tab on a 320pt screen.
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                  >
                    {label}
                  </Animated.Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </BlurView>
    </View>
  );
}

export default function TabsLayout() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.tabBarActive,
        tabBarInactiveTintColor: colors.tabBarInactive,
      }}
    >
      <Tabs.Screen name="home" options={{ title: t('tabs.home') }} />
      <Tabs.Screen name="teams" options={{ title: t('tabs.teams') }} />
      <Tabs.Screen name="games" options={{ title: t('tabs.track') }} />
      <Tabs.Screen name="stats" options={{ title: t('tabs.stats') }} />
      <Tabs.Screen
        name="invitations"
        options={{
          href: null,
          title: t('tabs.invitations'),
        }}
      />
      <Tabs.Screen name="profile" options={{ title: t('tabs.profile') }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBarOuter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  blurContainer: {
    overflow: 'hidden',
  },
  tabBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    position: 'relative',
  },
  pill: {
    position: 'absolute',
    left: 0,
    height: 40,
    borderRadius: borderRadius.xl,
    top: 10,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: TAB_BAR_HEIGHT,
  },
  iconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The bar keeps TAB_BAR_HEIGHT (useTabBarPadding depends on it), so the
  // label's scaling is capped and its line height bounded: 24pt icon + 2 +
  // 12 x 1.3 stays inside the 60pt item at every text size (#776).
  tabLabel: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  trackButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
      },
      android: {
        elevation: 6,
      },
    }),
  },
});
