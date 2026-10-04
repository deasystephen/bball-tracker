/**
 * Screen-reader announcements (#774).
 *
 * The one place the app calls `AccessibilityInfo.announceForAccessibility*`,
 * so tests mock a single module and a native failure can never throw into a
 * render. Announcements are queued (iOS) rather than interrupting each other:
 * recording a shot changes the score and opens the undo window in the same
 * moment, and both should be heard. Android has no queue option; TalkBack
 * speaks them in order.
 *
 * Call sites: `components/game/ScoreDisplay.tsx` and `app/games/[id]/live.tsx`
 * (through `hooks/useScoreAnnouncement.ts`), `components/Toast.tsx` and
 * `components/game/UndoBanner.tsx`.
 */

import { AccessibilityInfo } from 'react-native';
import { log } from '../services/log';

export function announce(message: string): void {
  if (!message) return;
  try {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  } catch (error) {
    // Never log the message itself: it can carry a player's name.
    log.warn('Screen-reader announcement failed', { error });
  }
}
