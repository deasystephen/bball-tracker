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
  // Team names only shape the message; a rename is not a score change, so
  // they ride in a ref instead of the effect's dependencies.
  const names = useRef({ home: homeTeamName, away: awayTeamName });
  useEffect(() => {
    names.current = { home: homeTeamName, away: awayTeamName };
  }, [homeTeamName, awayTeamName]);

  useEffect(() => {
    if (homeScore == null || awayScore == null) return;
    const key = `${homeScore}-${awayScore}`;
    const before = previous.current;
    previous.current = key;
    if (before === null || before === key) return;
    if (Platform.OS !== 'ios') return;
    const { home, away } = names.current;
    announce(scoreAccessibilityLabel(home, homeScore, away, awayScore));
  }, [homeScore, awayScore]);
}
