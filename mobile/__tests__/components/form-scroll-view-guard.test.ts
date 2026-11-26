/**
 * Guard: a form scrolls inside `FormScrollView`, never a raw `ScrollView` (#1118).
 *
 * A raw `<ScrollView keyboardShouldPersistTaps="handled">` relies on React
 * Native knowing that a keyboard is open. On iOS 27 it loses track, the tap on
 * a label no longer dismisses the keyboard, and the submit button stays under
 * it. `FormScrollView` dismisses on its own. Jest renders no keyboard, so this
 * reads the source instead.
 *
 * A screen whose inputs sit beside a `FlatList` has no ScrollView to swap: it
 * wraps the list and the inputs in `KeyboardDismissView` (#1122).
 */

import { jsxAttributes, lineOf, literalAttribute, parseTsx, tagNameOf, walkJsx } from '../helpers/source-files';
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

/** Virtualized lists: their rows are not JSX children, so an input can only sit beside one. */
const LISTS = new Set(['FlatList', 'SectionList', 'Animated.FlatList', 'Animated.SectionList', 'FlashList']);
const DISMISS_VIEW = 'components/KeyboardDismissView.tsx';

/**
 * A screen that renders a list and a text input (a composer above or below
 * the list) has no ScrollView to swap for `FormScrollView` (#1122): the list
 * sits inside a `KeyboardDismissView`, in `handled` mode so a tap on a row is
 * pressed, not swallowed, while the keyboard is up. The input may sit inside
 * the view (it marks its own touches) or outside it (the reply composer, so
 * that Send leaves the keyboard up). Read per file and by tag name: a list and
 * an input in the same source. A shared component that renders a list goes
 * into LISTS, as one that renders an input goes into TEXT_INPUTS.
 */
function findUncoveredListComposers(fileName: string, text: string): string[] {
  const source = parseTsx(fileName, text);
  const lists: { line: number; name: string; covered: boolean; handled: boolean }[] = [];
  let inputs = 0;

  walkJsx<boolean>(source, false, (node, covered) => {
    const name = tagNameOf(node);
    if (name === 'KeyboardDismissView') return true;
    if (LISTS.has(name)) {
      const handled = literalAttribute(jsxAttributes(node), 'keyboardShouldPersistTaps') === 'handled';
      lists.push({ line: lineOf(source, node), name, covered, handled });
    }
    if (TEXT_INPUTS.has(name)) inputs += 1;
    return covered;
  });

  if (inputs === 0) return [];
  return [
    ...lists
      .filter((list) => !list.covered)
      .map((list) => `${fileName}:${list.line} ${list.name} shares a screen with a text input: wrap it in KeyboardDismissView`),
    ...lists
      .filter((list) => !list.handled)
      .map((list) => `${fileName}:${list.line} ${list.name} shares a screen with a text input: set keyboardShouldPersistTaps="handled"`),
  ];
}

describe('lists with a composer', () => {
  it('every screen with a list and a text input wraps the list in KeyboardDismissView', () => {
    const findings = scannedSources()
      .filter(({ file }) => !file.endsWith(WRAPPER) && !file.endsWith(DISMISS_VIEW))
      .flatMap(({ file, text }) => findUncoveredListComposers(file, text));

    expect(findings).toEqual([]);
  });

  it('the two announcement screens are scanned and are the composer kind', () => {
    const composers = scannedSources().filter(({ text }) => /<(FlatList|SectionList)\b/.test(text) && /<Input\b/.test(text));

    expect(composers.map(({ file }) => file).sort()).toEqual(
      expect.arrayContaining([
        'app/teams/[id]/announcements.tsx',
        'app/teams/[id]/announcements/[announcementId].tsx',
      ])
    );
  });

  describe('the scanner', () => {
    it('reports the announcement defect: a composer beside a bare FlatList', () => {
      const findings = findUncoveredListComposers(
        'sample.tsx',
        `const Screen = () => (
          <KeyboardAvoidingView>
            <Input label="Title" />
            <FlatList data={rows} renderItem={renderItem} />
          </KeyboardAvoidingView>
        );`
      );
      expect(findings).toEqual([
        'sample.tsx:4 FlatList shares a screen with a text input: wrap it in KeyboardDismissView',
        'sample.tsx:4 FlatList shares a screen with a text input: set keyboardShouldPersistTaps="handled"',
      ]);
    });

    it('reports a wrapped list that is not in handled mode, and accepts the input outside the wrapper', () => {
      const findings = findUncoveredListComposers(
        'sample.tsx',
        `const Screen = () => (
          <>
            <KeyboardDismissView>
              <SectionList sections={sections} keyboardShouldPersistTaps="always" />
            </KeyboardDismissView>
            <TextInput />
          </>
        );`
      );
      expect(findings).toEqual([
        'sample.tsx:4 SectionList shares a screen with a text input: set keyboardShouldPersistTaps="handled"',
      ]);
    });

    it('accepts a wrapped composer, a list with no input and an input with no list', () => {
      const wrapped = findUncoveredListComposers(
        'sample.tsx',
        `const Screen = () => (
          <KeyboardDismissView>
            <FlatList data={rows} renderItem={renderItem} keyboardShouldPersistTaps="handled" />
            <View><Input placeholder="Reply" /></View>
          </KeyboardDismissView>
        );`
      );
      const listOnly = findUncoveredListComposers('sample.tsx', `const Screen = () => <FlatList data={rows} />;`);
      const inputOnly = findUncoveredListComposers('sample.tsx', `const Screen = () => <View><Input /></View>;`);

      expect([wrapped, listOnly, inputOnly]).toEqual([[], [], []]);
    });
  });
});

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
