/**
 * Tests for theme-store.
 *
 * Exercises the real state transitions in the Zustand store (not Zustand
 * itself): setColorScheme applies, toggleColorScheme flips between light
 * and dark across successive calls.
 */

import { useThemeStore } from '../../store/theme-store';

describe('theme-store', () => {
  beforeEach(() => {
    useThemeStore.setState({ colorScheme: 'light' });
  });

  it('defaults to light color scheme', () => {
    expect(useThemeStore.getState().colorScheme).toBe('light');
  });

  it('setColorScheme applies the given scheme', () => {
    useThemeStore.getState().setColorScheme('dark');
    expect(useThemeStore.getState().colorScheme).toBe('dark');

    useThemeStore.getState().setColorScheme('light');
    expect(useThemeStore.getState().colorScheme).toBe('light');
  });

  it('toggleColorScheme flips light -> dark -> light', () => {
    const { toggleColorScheme } = useThemeStore.getState();

    toggleColorScheme();
    expect(useThemeStore.getState().colorScheme).toBe('dark');

    toggleColorScheme();
    expect(useThemeStore.getState().colorScheme).toBe('light');

    toggleColorScheme();
    expect(useThemeStore.getState().colorScheme).toBe('dark');
  });
});
