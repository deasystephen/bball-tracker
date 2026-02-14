import React, { useCallback } from 'react';
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
import { borderRadius } from '../../theme';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

const TAB_CONFIGS = [
  { name: 'home', icon: 'home', label: 'Home' },
  { name: 'teams', icon: 'people', label: 'Teams' },
  { name: 'games', icon: 'basketball', label: 'Track' },
  { name: 'stats', icon: 'stats-chart', label: 'Stats' },
  { name: 'profile', icon: 'person', label: 'Profile' },
] as const;

const TRACK_INDEX = 2;

function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const { colors, colorScheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const tabWidth = screenWidth / TAB_CONFIGS.length;
  const pillPosition = useSharedValue(0);
  const scale0 = useSharedValue(1);
  const scale1 = useSharedValue(1);
  const scale2 = useSharedValue(1);
  const scale3 = useSharedValue(1);
  const scale4 = useSharedValue(1);
  const scales = [scale0, scale1, scale2, scale3, scale4];

  const handlePress = useCallback(
    (index: number, routeName: string, isFocused: boolean) => {
      if (!isFocused) {
        pillPosition.value = withSpring(index, {
          damping: 18,
          stiffness: 200,
        });
        scales[index].value = withSequence(
          withSpring(1.15, { damping: 6, stiffness: 300 }),
          withSpring(1, { damping: 8, stiffness: 200 })
        );
        navigation.navigate(routeName);
      }
    },
    [navigation, pillPosition, scales]
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

  // Map Expo Router state indices to our 5-tab config
  const activeRouteName = state.routes[state.index]?.name;
  const visualIndex = TAB_CONFIGS.findIndex((t) => t.name === activeRouteName);
  const activeVisualIndex = visualIndex >= 0 ? visualIndex : 0;

  return (
    <View style={[styles.tabBarOuter, { paddingBottom: insets.bottom }]}>
      <BlurView
        intensity={80}
        tint={colorScheme === 'dark' ? 'dark' : 'light'}
        style={styles.blurContainer}
      >
        <View
          style={[
            styles.tabBarInner,
            {
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
              { backgroundColor: colors.primary + '18' },
              pillStyle,
            ]}
          />

          {TAB_CONFIGS.map((tab, index) => {
            const isFocused = activeVisualIndex === index;
            const isTrackTab = index === TRACK_INDEX;

            const routeIndex = state.routes.findIndex(
              (r) => r.name === tab.name
            );
            const routeName =
              routeIndex >= 0 ? state.routes[routeIndex].name : tab.name;

            return (
              <TouchableOpacity
                key={tab.name}
                onPress={() => handlePress(index, routeName, isFocused)}
                style={styles.tabItem}
                accessibilityRole="button"
                accessibilityState={{ selected: isFocused }}
                accessibilityLabel={
                  tab.label === 'Track'
                    ? 'Track game tab'
                    : `${tab.label} tab`
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
                  >
                    {tab.label}
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

  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.tabBarActive,
        tabBarInactiveTintColor: colors.tabBarInactive,
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Home' }} />
      <Tabs.Screen name="teams" options={{ title: 'Teams' }} />
      <Tabs.Screen name="games" options={{ title: 'Track' }} />
      <Tabs.Screen name="stats" options={{ title: 'Stats' }} />
      <Tabs.Screen
        name="invitations"
        options={{
          href: null,
          title: 'Invitations',
        }}
      />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
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
    height: 60,
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
    height: 60,
  },
  iconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontSize: 10,
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
