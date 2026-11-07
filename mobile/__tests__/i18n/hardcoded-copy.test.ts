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
 * Allowed: literals with no letter (numbers, `·`, `—`, `%`), URLs, the product name
 * (`ALLOWED_LITERALS`), and code that only runs in a development build
 * (`__DEV__ && …`). Everything else goes into `i18n/locales/en.json` and
 * `es.json`; `locale-parity.test.ts` keeps the two in step.
 *
 * `PENDING_FILES` listed the screens not converted yet while the conversion ran
 * in three PRs; it only shrank (an entry with no findings left failed) and has
 * been empty since the last one.
 */

import path from 'path';

import { MOBILE_ROOT, readSource, sourceFiles } from '../helpers/source-files';
import { ALLOWED_LITERALS, findHardcodedCopy } from '../helpers/hardcoded-copy';

/** Directories scanned, relative to `mobile/`. */
const SCANNED_DIRS = ['app', 'components', 'hooks', 'services', 'utils'] as const;

/** Fewer files than this means the scan went wrong, not that the app shrank. */
const MIN_SCANNED_FILES = 100;

/**
 * Files still carrying English literals. Empty since #671 finished the conversion; a
 * future exception needs a reason here and a follow-up issue, never a silent entry.
 */
const PENDING_FILES: readonly string[] = [];

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
          toast.showToast(getApiErrorMessage(error, 'Failed to save'), 'error');
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
        "'Failed to save'",
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
              <ThemedText>&ldquo;{quote}&rdquo;</ThemedText>
              <ThemedText>Hooplings</ThemedText>
              <Input placeholder="https://chat.whatsapp.com/..." />
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
