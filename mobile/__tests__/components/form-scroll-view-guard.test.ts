/**
 * Guard: a form scrolls inside `FormScrollView`, never a raw `ScrollView` (#1118).
 *
 * A raw `<ScrollView keyboardShouldPersistTaps="handled">` relies on React
 * Native knowing that a keyboard is open. On iOS 27 it loses track, the tap on
 * a label no longer dismisses the keyboard, and the submit button stays under
 * it. `FormScrollView` dismisses on its own. Jest renders no keyboard, so this
 * reads the source instead.
 */

import { jsxAttributes, lineOf, parseTsx, tagNameOf, walkJsx } from '../helpers/source-files';
import { scannedSources } from '../helpers/pressables';

/** Text inputs, and the shared components that render one. */
const TEXT_INPUTS = new Set(['Input', 'TextInput', 'PracticeDetailsFields']);
const RAW_SCROLL_VIEWS = new Set(['ScrollView', 'Animated.ScrollView', 'KeyboardAwareScrollView']);
const WRAPPER = 'components/FormScrollView.tsx';

function findRawFormScrollViews(fileName: string, text: string): string[] {
  const source = parseTsx(fileName, text);
  const findings = new Set<string>();

  walkJsx<number | null>(source, null, (node, rawScrollViewLine) => {
    const name = tagNameOf(node);
    if (name === 'FormScrollView') return null;
    if (RAW_SCROLL_VIEWS.has(name)) {
      const line = lineOf(source, node);
      if (jsxAttributes(node).has('keyboardShouldPersistTaps')) {
        findings.add(`${fileName}:${line} ${name} sets keyboardShouldPersistTaps: use FormScrollView`);
      }
      return line;
    }
    if (TEXT_INPUTS.has(name) && rawScrollViewLine !== null) {
      findings.add(
        `${fileName}:${lineOf(source, node)} ${name} is inside the ScrollView at line ${rawScrollViewLine}: use FormScrollView`
      );
    }
    return rawScrollViewLine;
  });

  return [...findings];
}

describe('form scroll views', () => {
  it('no screen puts a text input in a raw ScrollView', () => {
    const findings = scannedSources()
      .filter(({ file }) => !file.endsWith(WRAPPER))
      .flatMap(({ file, text }) => findRawFormScrollViews(file, text));

    expect(findings).toEqual([]);
  });

  describe('the scanner', () => {
    it('reports the Create Team defect: a raw ScrollView in handled mode', () => {
      const findings = findRawFormScrollViews(
        'sample.tsx',
        `const Form = () => (
          <ScrollView keyboardShouldPersistTaps="handled">
            <Input label="Age group" />
          </ScrollView>
        );`
      );
      expect(findings).toHaveLength(2);
      expect(findings[0]).toContain('sets keyboardShouldPersistTaps');
      expect(findings[1]).toContain('Input is inside the ScrollView at line 2');
    });

    it('reports a text input in a ScrollView that sets no keyboard mode', () => {
      const findings = findRawFormScrollViews(
        'sample.tsx',
        `const Form = () => (
          <ScrollView>
            <View><TextInput /></View>
          </ScrollView>
        );`
      );
      expect(findings).toEqual(['sample.tsx:3 TextInput is inside the ScrollView at line 2: use FormScrollView']);
    });

    it('reports a component that renders inputs, and an animated scroll view', () => {
      const findings = findRawFormScrollViews(
        'sample.tsx',
        `const Form = () => (
          <Animated.ScrollView>
            <PracticeDetailsFields value={details} onChange={onChange} />
          </Animated.ScrollView>
        );`
      );
      expect(findings).toEqual([
        'sample.tsx:3 PracticeDetailsFields is inside the ScrollView at line 2: use FormScrollView',
      ]);
    });

    it('accepts FormScrollView, and a ScrollView with no input', () => {
      const findings = findRawFormScrollViews(
        'sample.tsx',
        `const Form = () => (
          <>
            <FormScrollView><Input label="Name" /></FormScrollView>
            <ScrollView><Text>Read only</Text></ScrollView>
          </>
        );`
      );
      expect(findings).toEqual([]);
    });
  });
});
