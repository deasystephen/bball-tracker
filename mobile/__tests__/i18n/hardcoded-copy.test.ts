/**
 * Hard-coded copy guard (#671).
 *
 * Spanish is a supported locale (owner decision 2026-10-24): a device set to
 * Español must show no English. `i18n/config.ts` renders `es.json` for every
 * string that goes through `t()`, so the only way English reaches that device
 * is a literal in the source. The audit found 760-odd of them, from tab titles
 * to VoiceOver labels, and nothing failed: `jest.setup.js` pins the test
 * locale to `en`, where a literal and its key render the same.
 *
 * This reads the source of `app/`, `components/`, `hooks/`, `services/` and `utils/` and
 * fails on copy written as a literal: JSX text, a copy prop (`title`, `label`,
 * `placeholder`, `accessibilityLabel`, …) on an element, an object or a
 * destructured default, an `Alert.alert` title, message or button, a toast, an
 * access-guard message, or a validation error. What counts is decided by
 * position, never by spelling: `__tests__/helpers/hardcoded-copy.ts`.
 *
 * Allowed: literals with no letter (numbers, `·`, `—`, `%`), the product name
 * (`ALLOWED_LITERALS`), and code that only runs in a development build
 * (`__DEV__ && …`). Everything else goes into `i18n/locales/en.json` and
 * `es.json`; `locale-parity.test.ts` keeps the two in step.
 *
 * `PENDING_FILES` lists the screens not converted yet. It only shrinks: an
 * entry with no findings left fails, so it is removed in the PR that converts
 * the file, and the list is empty once the conversion is done.
 */

import path from 'path';

import { MOBILE_ROOT, readSource, sourceFiles } from '../helpers/source-files';
import { ALLOWED_LITERALS, findHardcodedCopy } from '../helpers/hardcoded-copy';

/** Directories scanned, relative to `mobile/`. */
const SCANNED_DIRS = ['app', 'components', 'hooks', 'services', 'utils'] as const;

/** Fewer files than this means the scan went wrong, not that the app shrank. */
const MIN_SCANNED_FILES = 100;

/** Files still carrying English literals, converted by the next #671 PRs. */
const PENDING_FILES: readonly string[] = [
  'app/(tabs)/games.tsx',
  'app/(tabs)/home.tsx',
  'app/(tabs)/invitations.tsx',
  'app/(tabs)/profile.tsx',
  'app/(tabs)/stats.tsx',
  'app/(tabs)/teams.tsx',
  'app/about.tsx',
  'app/account/delete.tsx',
  'app/admin/index.tsx',
  'app/admin/leagues/[id].tsx',
  'app/admin/leagues/create.tsx',
  'app/admin/seasons/create.tsx',
  'app/auth/callback.tsx',
  'app/games/[id]/index.tsx',
  'app/games/[id]/live.tsx',
  'app/games/[id]/stats.tsx',
  'app/games/[id]/track.tsx',
  'app/games/create.tsx',
  'app/invite/[token].tsx',
  'app/login.tsx',
  'app/onboarding/index.tsx',
  'app/onboarding/name.tsx',
  'app/players/[id]/stats.tsx',
  'app/teams/[id].tsx',
  'app/teams/[id]/announcements.tsx',
  'app/teams/[id]/edit.tsx',
  'app/teams/[id]/players.tsx',
  'app/teams/[id]/players/[playerId]/guardians.tsx',
  'app/teams/[id]/staff.tsx',
  'app/teams/[id]/stats.tsx',
  'app/teams/create.tsx',
  'components/game/EventTimeline.tsx',
  'components/game/GameCard.tsx',
  'components/game/OpponentScoreButtons.tsx',
  'components/game/PlayerRoster.tsx',
  'components/game/ScoreDisplay.tsx',
  'components/game/ShotButtons.tsx',
  'components/game/StatButtons.tsx',
  'components/game/UndoBanner.tsx',
  'components/stats/BoxScoreTable.tsx',
  'components/stats/PlayerStatsCard.tsx',
  'components/stats/SeasonAverages.tsx',
];

function scannedFiles(): string[] {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx']))
    .map((absolute) => path.relative(MOBILE_ROOT, absolute))
    .sort();
  if (files.length < MIN_SCANNED_FILES) {
    throw new Error(`hard-coded copy guard scanned only ${files.length} files under ${SCANNED_DIRS.join(', ')}`);
  }
  return files;
}

describe('hard-coded copy (#671)', () => {
  const files = scannedFiles();

  it('finds no user-facing literal outside the pending files', () => {
    const findings = files
      .filter((file) => !PENDING_FILES.includes(file))
      .flatMap((file) => findHardcodedCopy(file, readSource(file)));

    expect(findings.map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
  });

  it('lists only pending files that exist and still need converting', () => {
    const stale = PENDING_FILES.filter(
      (file) => !files.includes(file) || findHardcodedCopy(file, readSource(file)).length === 0
    );

    expect(stale).toEqual([]);
  });

  it('allows only the product name as a lettered literal', () => {
    expect([...ALLOWED_LITERALS]).toEqual(['Hooplings']);
  });

  describe('the scanner', () => {
    const texts = (source: string): string[] => findHardcodedCopy('sample.tsx', source).map((f) => f.text);

    it('reports JSX text, string children and copy props', () => {
      expect(
        texts(`
          const A = () => (
            <View>
              <ThemedText>Games</ThemedText>
              <ThemedText>{pending ? 'SAVING…' : \`UNDO (\${countdown}s)\`}</ThemedText>
              <Button title="Create Game" accessibilityLabel={'Create game'} />
              <Input placeholder={\`Search \${team}\`} label={x || 'Name'} />
            </View>
          );
        `)
      ).toEqual([
        'Games',
        "'SAVING…'",
        '`UNDO (${countdown}s)`',
        '"Create Game"',
        "'Create game'",
        '`Search ${team}`',
        "'Name'",
      ]);
    });

    it('reports copy keys in objects, destructured defaults, alerts, toasts and validation errors', () => {
      expect(
        texts(`
          const OPTIONS = [{ key: 'name', label: 'Name' }];
          function ErrorState({ title = 'Something went wrong' }) {}
          Alert.alert('Delete Team', 'Are you sure?', [{ text: 'Cancel', style: 'cancel' }]);
          toast.showToast('Team deleted', 'success');
          useAccessGuard(ready, allowed, 'Coaches only', { mode: 'replace' });
          setNameError('Name is required');
          errors.name = 'Team name is required';
          <Tabs.Screen options={{ title: 'Home' }} />;
        `)
      ).toEqual([
        "'Name'",
        "'Something went wrong'",
        "'Delete Team'",
        "'Are you sure?'",
        "'Cancel'",
        "'Team deleted'",
        "'Coaches only'",
        "'Name is required'",
        "'Team name is required'",
        "'Home'",
      ]);
    });

    it('ignores values, translated copy, symbols, the product name and development-only code', () => {
      expect(
        texts(`
          const A = () => (
            <View testID="games-list" style={styles.row}>
              {status === 'LIVE' && <Badge />}
              <ThemedText>{t('games.title')}</ThemedText>
              <ThemedText>{count} · {total}</ThemedText>
              <ThemedText>Hooplings</ThemedText>
              <Button title={t('common.save')} variant="primary" onPress={() => router.push('/teams')} />
              {__DEV__ && <ThemedText>Debug</ThemedText>}
            </View>
          );
          toast.showToast(t('teams.deleted'), 'success');
          const renderDebug = () => {
            if (!__DEV__) return null;
            return <ThemedText>token</ThemedText>;
          };
        `)
      ).toEqual([]);
    });

    it('reports the line of each finding', () => {
      expect(findHardcodedCopy('sample.tsx', 'const a = 1;\nconst B = () => <Text>Hi</Text>;')).toEqual([
        { file: 'sample.tsx', line: 2, text: 'Hi' },
      ]);
    });
  });
});
