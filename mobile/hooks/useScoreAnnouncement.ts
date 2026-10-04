/**
 * Score labelling and change announcements for the live score headers (#774):
 * the tracker's `ScoreDisplay` and the spectator `app/games/[id]/live.tsx`.
 *
 * The score container carries `scoreAccessibilityLabel(...)` as one
 * accessible element with `accessibilityLiveRegion="polite"`, which is how
 * TalkBack (Android) hears a change. VoiceOver (iOS) has no live regions, so
 * this hook announces the new label when either score changes. It never
 * announces the first score it sees (mount, or the game loading), and it
 * stays silent on Android so TalkBack does not hear each change twice.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { announce } from '../utils/announce';

export function scoreAccessibilityLabel(
  homeTeamName: string,
  homeScore: number,
  awayTeamName: string,
  awayScore: number
): string {
  return `Score: ${homeTeamName} ${homeScore}, ${awayTeamName} ${awayScore}`;
}

export function useScoreAnnouncement(
  homeTeamName: string,
  homeScore: number | null | undefined,
  awayTeamName: string,
  awayScore: number | null | undefined
): void {
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (homeScore == null || awayScore == null) return;
    // Keyed on the scores only: a team rename re-runs the effect but finds
    // the same key and says nothing.
    const key = `${homeScore}-${awayScore}`;
    const before = previous.current;
    previous.current = key;
    if (before === null || before === key) return;
    if (Platform.OS !== 'ios') return;
    announce(scoreAccessibilityLabel(homeTeamName, homeScore, awayTeamName, awayScore));
  }, [homeScore, awayScore, homeTeamName, awayTeamName]);
}
