/**
 * The 44pt minimum touch target (Apple HIG, WCAG 2.5.5) in one place (#772).
 *
 * Text controls (pills, chips, banner buttons) take `minHeight: MIN_TOUCH_TARGET`.
 * Icon buttons keep their drawn size and reach 44pt through `hitSlop`, so the
 * glyph and the header layout around it do not move.
 */

import type { Insets } from 'react-native';

import { spacing } from '../theme/spacing';

export const MIN_TOUCH_TARGET = 44;

/**
 * The `hitSlop` that grows a control drawn at `width` x `height` points to at
 * least 44 x 44. A side that is already 44 or more gets no slop.
 */
export function touchTargetHitSlop(width: number, height: number = width): Insets {
  const horizontal = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - width) / 2));
  const vertical = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - height) / 2));
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}

/**
 * The header icon button: a 24pt icon with `padding: spacing.sm`, drawn at
 * 40pt. `__tests__/a11y/touch-targets.test.ts` checks every use against the
 * button's real size.
 */
export const HEADER_ICON_HIT_SLOP = touchTargetHitSlop(24 + 2 * spacing.sm);
