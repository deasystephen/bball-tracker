/**
 * Guard: a full-screen error on a pushed screen offers a way back (#595).
 *
 * Every pushed screen draws its own header (the root `Stack` has
 * `headerShown: false`), and `ErrorState` is returned in place of the whole
 * screen. So the back arrow goes with it, and with `onRetry` alone the user is
 * left with Try Again and the swipe gesture, which nothing on screen mentions
 * and VoiceOver cannot use. Found on the player stats screen (#589); twelve
 * more screens had it.
 *
 * This reads the source, like the nested-pressables guard: a screen test
 * proves one screen, and the defect comes back with the next new one.
 *
 * Tab screens are out of scope: the tab bar is always there.
 *
 * Allowed: a screen that renders `ErrorState` under its own header, which
 * stays on screen. It goes on `KEEPS_HEADER` with the reason, and must have a
 * control labelled "Go back" of its own: a `<BackButton>` (which carries that
 * label) or a pressable with `accessibilityLabel="Go back"`.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { MOBILE_ROOT, sourceFiles } from '../helpers/source-files';

const APP_DIR = path.join(MOBILE_ROOT, 'app');
const TABS_DIR = path.join(APP_DIR, '(tabs)');

/** Screens that render `ErrorState` below a header that stays. Path → reason. */
const KEEPS_HEADER: Record<string, string> = {
  'app/teams/[id]/announcements.tsx':
    'the error replaces only the list; the header with its back arrow is rendered above it in every state',
};

interface Finding {
  file: string;
  line: number;
}

interface Scan {
  /** `<ErrorState>` elements with no `onBack`. */
  withoutBack: Finding[];
  /** Whether the file has a control of its own labelled "Go back". */
  hasOwnBackControl: boolean;
}

export function scanErrorStates(fileName: string, text: string): Scan {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const withoutBack: Finding[] = [];
  let hasOwnBackControl = false;

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText();
      const attributes = new Map<string, string>();
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute)) {
          attributes.set(attribute.name.getText(), attribute.initializer?.getText() ?? 'true');
        }
      }
      if (name === 'ErrorState') {
        if (!attributes.has('onBack')) {
          withoutBack.push({
            file: fileName,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          });
        }
      } else if (name === 'BackButton' || /^["']Go back["']$/.test(attributes.get('accessibilityLabel') ?? '')) {
        hasOwnBackControl = true;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { withoutBack, hasOwnBackControl };
}

/** Pushed screens: every `.tsx` under `app/` except the tab screens. */
function pushedScreenFiles(): string[] {
  return sourceFiles(APP_DIR, ['.tsx']).filter((file) => !file.startsWith(TABS_DIR + path.sep));
}

function scanFile(relative: string): Scan {
  return scanErrorStates(relative, fs.readFileSync(path.join(MOBILE_ROOT, relative), 'utf8'));
}

describe('full-screen errors on pushed screens', () => {
  const files = pushedScreenFiles().map((file) => path.relative(MOBILE_ROOT, file));

  it('offer a way back', () => {
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((file) => file.startsWith(path.join('app', '(tabs)')))).toEqual([]);

    const findings = files
      .filter((file) => !(file in KEEPS_HEADER))
      .flatMap((file) => scanFile(file).withoutBack);

    expect(findings.map((f) => `${f.file}:${f.line} renders ErrorState without onBack`)).toEqual([]);
  });

  it('scans the screens known to render ErrorState', () => {
    const rendering = files.filter((file) => fs.readFileSync(path.join(MOBILE_ROOT, file), 'utf8').includes('<ErrorState'));

    // 16 screens pass `onBack`, one keeps its header (#595, #614, #34); the
    // enumerated set is `SCREENS` in __tests__/app/error-state-way-back.test.tsx.
    expect(rendering.length).toBeGreaterThanOrEqual(17);
    expect(rendering).toContain(path.join('app', 'players', '[id]', 'stats.tsx'));
  });

  describe('the screens that keep their header', () => {
    it.each(Object.entries(KEEPS_HEADER))('%s: %s', (file) => {
      const scan = scanFile(file);

      // An entry that no longer needs the exception is removed, not kept.
      expect(scan.withoutBack.length).toBeGreaterThan(0);
      expect(scan.hasOwnBackControl).toBe(true);
    });
  });

  describe('the scanner', () => {
    it('reports an ErrorState with only onRetry: the player stats defect', () => {
      const scan = scanErrorStates(
        'sample.tsx',
        `
        const Screen = () => {
          if (error) {
            return (
              <ErrorState
                message={error.message}
                onRetry={refetch}
              />
            );
          }
          return <View />;
        };
        `
      );

      expect(scan.withoutBack).toEqual([{ file: 'sample.tsx', line: 5 }]);
    });

    it('reports each one in a file that has several', () => {
      const scan = scanErrorStates(
        'sample.tsx',
        `
        const Screen = () => {
          if (error) return <ErrorState message="Failed" onRetry={refetch} onBack={goBack} />;
          if (closed) return <ErrorState message="Closed" />;
          return loading ? <Spinner /> : <ErrorState message="Empty" onRetry={refetch}></ErrorState>;
        };
        `
      );

      expect(scan.withoutBack.map((f) => f.line)).toEqual([4, 5]);
    });

    it('accepts an ErrorState that passes onBack', () => {
      const scan = scanErrorStates(
        'sample.tsx',
        `const Screen = () => <ErrorState message="Failed" onRetry={refetch} onBack={goBack} />;`
      );

      expect(scan.withoutBack).toEqual([]);
    });

    it('does not take props spread onto it as a way back', () => {
      const scan = scanErrorStates('sample.tsx', `const Screen = () => <ErrorState {...props} />;`);

      expect(scan.withoutBack).toHaveLength(1);
    });

    it('finds a back control of the screen, and does not count the one inside ErrorState', () => {
      const header = scanErrorStates(
        'sample.tsx',
        `
        const Screen = () => (
          <View>
            <TouchableOpacity accessibilityLabel="Go back" onPress={back}><Icon /></TouchableOpacity>
            {error ? <ErrorState message="Failed" /> : <List />}
          </View>
        );
        `
      );
      const none = scanErrorStates(
        'sample.tsx',
        `const Screen = () => <ErrorState message="Failed" backLabel="Go back" accessibilityLabel="Go back" />;`
      );

      expect(header.hasOwnBackControl).toBe(true);
      expect(none.hasOwnBackControl).toBe(false);
    });

    it('counts the shared BackButton as a back control of the screen', () => {
      const scan = scanErrorStates(
        'sample.tsx',
        `const Screen = () => <View><BackButton onPress={back} />{error ? <ErrorState message="Failed" /> : null}</View>;`
      );

      expect(scan.hasOwnBackControl).toBe(true);
    });
  });
});
