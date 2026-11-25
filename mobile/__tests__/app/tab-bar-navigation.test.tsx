/**
 * Custom tab bar (#922).
 *
 * Expo SDK 58's router fork changed what it hands a custom `tabBar`: the
 * `navigation` prop is gone and `navigateToTab(route.key)` replaces
 * `navigation.navigate(route.name)`. A tab bar still written against the old
 * props throws on every tap, and nothing else in Jest renders the bar (the
 * shared expo-router mock has no navigator). This drives the real
 * `CustomTabBar` with the props the SDK 58 navigator passes.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { BottomTabBarProps } from 'expo-router/js-tabs';

import TabsLayout from '../../app/(tabs)/_layout';

const mockNavigateToTab = jest.fn();
let mockFocusedIndex = 0;

// Route order is the navigator's, not the bar's: `invitations` sits between
// tabs the bar shows and must never be reachable through an off-by-one.
const mockRoutes = ['home', 'teams', 'invitations', 'games', 'stats', 'profile'].map((name) => ({
  key: `${name}-key`,
  name,
}));

jest.mock('expo-router', () => {
  const Tabs = ({ tabBar }: { tabBar: (props: unknown) => React.ReactNode }): React.ReactNode =>
    tabBar({
      state: { index: mockFocusedIndex, routes: mockRoutes },
      descriptors: {},
      emitter: { emit: jest.fn() },
      navigateToTab: mockNavigateToTab,
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    } satisfies Record<keyof BottomTabBarProps, unknown>);
  Tabs.Screen = function Screen(): null {
    return null;
  };
  return { Tabs };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

const tab = (name: string): ReturnType<typeof screen.getByRole> => screen.getByRole('button', { name });

describe('custom tab bar', () => {
  beforeEach(() => {
    mockNavigateToTab.mockClear();
    mockFocusedIndex = 0;
  });

  it.each([
    ['Teams tab', 'teams-key'],
    ['Track game tab', 'games-key'],
    ['Stats tab', 'stats-key'],
    ['Profile tab', 'profile-key'],
  ])('%s navigates by the key of its own route', (label, key) => {
    render(<TabsLayout />);
    fireEvent.press(tab(label));
    expect(mockNavigateToTab).toHaveBeenCalledTimes(1);
    expect(mockNavigateToTab).toHaveBeenCalledWith(key);
  });

  it('does not navigate when the focused tab is tapped', () => {
    render(<TabsLayout />);
    fireEvent.press(tab('Home tab'));
    expect(mockNavigateToTab).not.toHaveBeenCalled();
  });

  it('marks the tab of the focused route as selected, whatever its index in the navigator', () => {
    mockFocusedIndex = mockRoutes.findIndex((r) => r.name === 'stats');
    render(<TabsLayout />);
    expect(tab('Stats tab').props.accessibilityState).toEqual({ selected: true });
    expect(tab('Home tab').props.accessibilityState).toEqual({ selected: false });

    fireEvent.press(tab('Home tab'));
    expect(mockNavigateToTab).toHaveBeenCalledWith('home-key');
  });
});

// The bar finds each button's route by name. A name with no screen file under
// app/(tabs)/ would render a button that can never navigate.
describe('tab bar configuration', () => {
  it('names only tabs that have a screen file', () => {
    const tabsDir = join(__dirname, '..', '..', 'app', '(tabs)');
    const config = readFileSync(join(tabsDir, '_layout.tsx'), 'utf8').match(/const TAB_CONFIGS = \[([\s\S]*?)\] as const;/)?.[1];
    const names = [...(config ?? '').matchAll(/name: '([^']+)'/g)].map((m) => m[1]);

    expect(names).toEqual(['home', 'teams', 'games', 'stats', 'profile']);
    for (const name of names) {
      expect(existsSync(join(tabsDir, `${name}.tsx`))).toBe(true);
    }
  });
});
