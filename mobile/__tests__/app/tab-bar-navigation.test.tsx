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
// The shared reanimated mock makes a new shared value on every render, so a
// pill that only starts in the right place would pass for one that follows the
// navigator. Here a shared value lives as long as its component, as the real
// one does. Otherwise it behaves like the shared mock: a spring resolves to
// its target at once, and an animated style is computed while rendering, so a
// value set in an effect shows on the next render.
const mockWithSpring = jest.fn(<T,>(value: T): T => value);
jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual<typeof import('react')>('react');
  const { View, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: { View, Text },
    useSharedValue: <T,>(initial: T) => {
      const ref = useRef<{ value: T; get: () => T; set: (next: T) => void } | null>(null);
      if (!ref.current) {
        const shared = { value: initial, get: (): T => shared.value, set: (next: T): void => void (shared.value = next) };
        ref.current = shared;
      }
      return ref.current;
    },
    useAnimatedStyle: <T,>(style: () => T): T => style(),
    withSpring: <T,>(value: T): T => mockWithSpring(value) as T,
    withSequence: <T,>(...values: T[]): T => values[0],
  };
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

  // The pill and the selected state follow the navigator, not the tap (#1117).
  describe('a tab change that does not come from a tap on the bar', () => {
    const focus = (name: string): void => {
      mockFocusedIndex = mockRoutes.findIndex((r) => r.name === name);
    };
    const pill = (): ReturnType<typeof screen.getByTestId> => screen.getByTestId('tab-bar-pill');
    // The Jest window is 750pt wide (react-native's preset): five tabs of 150pt.
    const TAB_WIDTH = 150;
    /** The navigator re-renders the bar with a new focused route; the second render shows the effect's value. */
    const navigatorMovesTo = (name: string, rerender: (ui: React.ReactElement) => void): void => {
      focus(name);
      rerender(<TabsLayout />);
      rerender(<TabsLayout />);
    };

    it('starts the pill under the focused tab', () => {
      focus('stats');
      render(<TabsLayout />);
      expect(pill()).toHaveStyle({ transform: [{ translateX: 3 * TAB_WIDTH }] });
    });

    it('moves the pill when the navigator changes tab on its own (router.replace, a deep link)', () => {
      const { rerender } = render(<TabsLayout />);
      expect(pill()).toHaveStyle({ transform: [{ translateX: 0 }] });

      navigatorMovesTo('teams', rerender);

      expect(pill()).toHaveStyle({ transform: [{ translateX: TAB_WIDTH }] });
      expect(tab('Teams tab').props.accessibilityState).toEqual({ selected: true });
      expect(tab('Home tab').props.accessibilityState).toEqual({ selected: false });
      expect(mockNavigateToTab).not.toHaveBeenCalled();
    });

    it('on the hidden Invitations tab selects nothing, hides the pill, and Home navigates', () => {
      focus('invitations');
      render(<TabsLayout />);

      for (const label of ['Home tab', 'Teams tab', 'Track game tab', 'Stats tab', 'Profile tab']) {
        expect(tab(label).props.accessibilityState).toEqual({ selected: false });
      }
      expect(pill()).toHaveStyle({ opacity: 0 });

      fireEvent.press(tab('Home tab'));
      expect(mockNavigateToTab).toHaveBeenCalledWith('home-key');
    });

    it('shows the pill again, under the right tab, after leaving Invitations', () => {
      focus('invitations');
      const { rerender } = render(<TabsLayout />);

      navigatorMovesTo('profile', rerender);

      expect(pill()).toHaveStyle({ opacity: 1, transform: [{ translateX: 4 * TAB_WIDTH }] });
    });

    it('springs between two tabs, and places the pill without a slide when it was hidden', () => {
      const { rerender } = render(<TabsLayout />);
      mockWithSpring.mockClear();
      navigatorMovesTo('teams', rerender);
      expect(mockWithSpring).toHaveBeenCalledWith(1);

      navigatorMovesTo('invitations', rerender);
      mockWithSpring.mockClear();
      navigatorMovesTo('profile', rerender);
      expect(mockWithSpring).not.toHaveBeenCalled();
      expect(pill()).toHaveStyle({ transform: [{ translateX: 4 * TAB_WIDTH }] });
    });

    it('a tap starts the pill at once, before the navigator answers', () => {
      const { rerender } = render(<TabsLayout />);
      fireEvent.press(tab('Stats tab'));
      // Same focused route: only the tap has happened.
      rerender(<TabsLayout />);
      expect(pill()).toHaveStyle({ transform: [{ translateX: 3 * TAB_WIDTH }] });
    });
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
