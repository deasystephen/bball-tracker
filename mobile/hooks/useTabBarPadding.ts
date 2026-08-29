import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../theme';

// Bar height excluding the bottom safe-area inset — the tab bar in
// app/(tabs)/_layout.tsx renders this tall and pads the inset below itself.
export const TAB_BAR_HEIGHT = 60;

// Bottom content padding for scrollable tab screens. The tab bar is an
// absolutely-positioned translucent overlay, so every tab screen must pad its
// scroll content by at least the bar's full footprint or the last rows can
// never scroll out from behind it. Use this instead of hand-rolling a
// paddingBottom per screen.
export function useTabBarPadding(): number {
  const insets = useSafeAreaInsets();
  return TAB_BAR_HEIGHT + insets.bottom + spacing.lg;
}
