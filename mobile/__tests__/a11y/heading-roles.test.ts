/**
 * Guard: screen titles and section headings carry the header role (#775).
 *
 * Every navigator hides the native header, so each screen draws its own title
 * as a `ThemedText`. VoiceOver's Headings rotor and TalkBack's heading
 * navigation find only elements with the header role; without it a screen
 * reader user swipes through every row to reach a section.
 *
 * `ThemedText`'s `heading` prop sets the role. It is opt-in, never a variant
 * default, because the heading variants also render numbers (scores, record
 * counts, stat values) that must not be announced as headings.
 *
 * Rules, read from the source:
 * 1. Every `<ThemedText variant="h1" | "h2">` under `app/` declares what it is:
 *    `heading` for a title, or `heading={false}` followed by a comment with the
 *    reason for a value (`heading={false} /* score, a value *\/`). The
 *    declaration sits at the site, so a rename or a reformat cannot break it.
 * 2. Every screen file under `app/` exposes at least one heading, unless it is
 *    listed in `SCREENS_WITHOUT_TITLE` (with the reason).
 * 3. The shared components that draw a title (`HEADING_COMPONENTS`) mark it;
 *    the ones that only draw numbers (`VALUE_COMPONENTS`) mark nothing.
 *
 * A heading is recognised by behaviour, not spelling: `heading` (bare or
 * `{true}`), `accessibilityRole="header"` or `role="heading"`, quoted or
 * braced. A role or `heading` given as an expression (a variable, a constant)
 * is a finding: the guard cannot tell what it renders, so declare it with a
 * literal.
 */

import path from 'path';

import {
  MOBILE_ROOT,
  jsxAttributes,
  lineOf,
  parseTsx,
  readSource,
  sourceFiles,
  tagNameOf,
  walkJsx,
} from '../helpers/source-files';
import type { JsxAttributeValue } from '../helpers/source-files';

/** Screen files under `app/` that draw no title, so there is nothing to mark. */
const SCREENS_WITHOUT_TITLE: Record<string, string> = {
  'app/_layout.tsx': 'navigator, renders no screen of its own',
  'app/(tabs)/_layout.tsx': 'navigator and custom tab bar',
  'app/onboarding/_layout.tsx': 'navigator',
  'app/index.tsx': 'launch redirect, shows only a loading line',
  'app/games/[id]/live.tsx': 'header is the score, one accessible live region that cannot contain a heading',
  'app/games/[id]/track.tsx':
    'tracker header is ScoreDisplay (one accessible element); EventTimeline marks "Recent Plays"',
};

/** Shared components whose title must carry the role. */
const HEADING_COMPONENTS = [
  'components/ActionMenu.tsx',
  'components/DateTimePickerSheet.tsx',
  'components/EmptyState.tsx',
  'components/ErrorState.tsx',
  'components/game/EventTimeline.tsx',
  'components/stats/SeasonAverages.tsx',
];

/** Shared components that draw scores and stat numbers in heading variants. */
const VALUE_COMPONENTS = [
  'components/game/GameCard.tsx',
  'components/game/ScoreDisplay.tsx',
  'components/stats/PlayerStatsCard.tsx',
  'components/stats/SeasonRecord.tsx',
];

/**
 * What an element declares about the header role:
 * - `heading`: it is one
 * - `not-heading`: it says it is not (`heading={false}`, another literal role)
 * - `undeclared`: it says nothing
 * - `unknown`: a role or `heading` given as an expression the guard cannot read
 */
type Declaration = 'heading' | 'not-heading' | 'undeclared' | 'unknown';

interface TextElement {
  line: number;
  tag: string;
  variant: string | null;
  declaration: Declaration;
  /** Why the declaration is `unknown`, for the finding. */
  unknownBecause?: string;
  children: string;
}

function roleDeclaration(value: JsxAttributeValue | undefined, headingRole: string): Declaration {
  if (!value) return 'undeclared';
  if (value.kind === 'literal') return value.value === headingRole ? 'heading' : 'not-heading';
  return 'unknown';
}

function headingPropDeclaration(value: JsxAttributeValue | undefined): Declaration {
  if (!value) return 'undeclared';
  if (value.kind === 'true') return 'heading';
  if (value.kind === 'literal' && value.value === true) return 'heading';
  if (value.kind === 'literal' && value.value === false) return 'not-heading';
  return 'unknown';
}

/** Every JSX element in `text`, with its variant, what it declares about the header role, and its children. */
function textElements(fileName: string, text: string): TextElement[] {
  const source = parseTsx(fileName, text);
  const found: TextElement[] = [];
  walkJsx(source, null, (node) => {
    const attributes = jsxAttributes(node);
    const tag = tagNameOf(node);
    const declarations: [string, Declaration][] = [
      ['accessibilityRole', roleDeclaration(attributes.get('accessibilityRole'), 'header')],
      ['role', roleDeclaration(attributes.get('role'), 'heading')],
    ];
    if (tag === 'ThemedText') {
      declarations.push(['heading', headingPropDeclaration(attributes.get('heading'))]);
    }

    // An unreadable role or flag makes the element unknown; otherwise any
    // header role makes it a heading (ThemedText lets an explicit role win).
    const declared = declarations.filter(([, d]) => d !== 'undeclared');
    const unknown = declared.find(([, d]) => d === 'unknown');
    let declaration: Declaration = 'undeclared';
    if (unknown) declaration = 'unknown';
    else if (declared.some(([, d]) => d === 'heading')) declaration = 'heading';
    else if (declared.length > 0) declaration = 'not-heading';

    const variant = attributes.get('variant');
    found.push({
      line: lineOf(source, node),
      tag,
      variant: variant?.kind === 'literal' && typeof variant.value === 'string' ? variant.value : null,
      declaration,
      unknownBecause: unknown ? `${unknown[0]} is an expression; declare it with a literal` : undefined,
      children:
        'children' in node
          ? node.children
              .map((child) => child.getText())
              .join('')
              .replace(/\s+/g, ' ')
              .trim()
          : '',
    });
    return null;
  });
  return found;
}

const isTitleVariant = (el: TextElement): boolean =>
  el.tag === 'ThemedText' && (el.variant === 'h1' || el.variant === 'h2');

describe('heading roles', () => {
  const screens = sourceFiles(path.join(MOBILE_ROOT, 'app'), ['.tsx']).map((file) =>
    path.relative(MOBILE_ROOT, file)
  );
  const elementsByScreen = new Map(screens.map((file) => [file, textElements(file, readSource(file))]));
  const allElements = [...elementsByScreen].flatMap(([file, elements]) => elements.map((el) => ({ file, el })));

  it('scans the app', () => {
    // A guard that scans nothing passes for the wrong reason.
    expect(screens.length).toBeGreaterThan(30);
  });

  it('makes every h1/h2 under app/ declare whether it is a heading', () => {
    const findings = allElements
      .filter(({ el }) => isTitleVariant(el) && el.declaration === 'undeclared')
      .map(
        ({ file, el }) =>
          `${file}:${el.line} <ThemedText variant="${el.variant}">${el.children} needs ` +
          '`heading` (a title) or `heading={false} /* reason */` (a value)'
      );
    expect(findings).toEqual([]);
  });

  it('can read every heading declaration under app/', () => {
    const findings = allElements
      .filter(({ el }) => el.declaration === 'unknown')
      .map(({ file, el }) => `${file}:${el.line} <${el.tag}>: ${el.unknownBecause}`);
    expect(findings).toEqual([]);
  });

  it('gives a reason next to every heading={false} under app/', () => {
    const findings = screens.flatMap((file) =>
      readSource(file)
        .split('\n')
        .flatMap((line, index) =>
          /heading=\{false\}/.test(line) && !/heading=\{false\}\s*\/\*\s*\S.*\*\//.test(line)
            ? [`${file}:${index + 1} ${line.trim()}`]
            : []
        )
    );
    expect(findings).toEqual([]);
  });

  it('gives every screen at least one heading', () => {
    const missing = screens.filter(
      (file) =>
        !(file in SCREENS_WITHOUT_TITLE) &&
        !(elementsByScreen.get(file) ?? []).some((el) => el.declaration === 'heading')
    );
    expect(missing).toEqual([]);
  });

  it('has no stale entry for a screen without a title', () => {
    const stale = Object.keys(SCREENS_WITHOUT_TITLE).filter(
      (file) =>
        !screens.includes(file) || (elementsByScreen.get(file) ?? []).some((el) => el.declaration === 'heading')
    );
    expect(stale).toEqual([]);
  });

  it.each(HEADING_COMPONENTS)('%s marks its title as a heading', (file) => {
    expect(textElements(file, readSource(file)).some((el) => el.declaration === 'heading')).toBe(true);
  });

  it.each(VALUE_COMPONENTS)('%s exposes no number as a heading', (file) => {
    expect(textElements(file, readSource(file)).filter((el) => el.declaration === 'heading')).toEqual([]);
  });

  describe('the scanner', () => {
    const declarations = (code: string) =>
      textElements('sample.tsx', `const S = () => (<View>${code}</View>);`)
        .filter((el) => el.tag !== 'View')
        .map((el) => [el.children, el.declaration]);

    it('recognises a heading in every literal spelling', () => {
      expect(
        declarations(`
          <ThemedText variant="h1" heading>A</ThemedText>
          <ThemedText variant="h1" heading={true}>B</ThemedText>
          <Text accessibilityRole="header">C</Text>
          <Text accessibilityRole={'header'}>D</Text>
          <Text role="heading">E</Text>
          <Text role={"heading"}>F</Text>
          <Text accessibilityRole="header" />
        `)
      ).toEqual([
        ['A', 'heading'],
        ['B', 'heading'],
        ['C', 'heading'],
        ['D', 'heading'],
        ['E', 'heading'],
        ['F', 'heading'],
        ['', 'heading'],
      ]);
    });

    it('tells a value that declares itself from one that says nothing', () => {
      expect(
        declarations(`
          <ThemedText variant="h2" heading={false} /* score, a value */>{game.homeScore}</ThemedText>
          <ThemedText variant="h2">{game.awayScore}</ThemedText>
          <Text accessibilityRole="text">Label</Text>
        `)
      ).toEqual([
        ['{game.homeScore}', 'not-heading'],
        ['{game.awayScore}', 'undeclared'],
        ['Label', 'not-heading'],
      ]);
    });

    it('reports a role or heading flag it cannot read as unknown', () => {
      expect(
        declarations(`
          <ThemedText variant="h1" heading={isTitle}>A</ThemedText>
          <Text accessibilityRole={HEADER_ROLE}>B</Text>
          <Text role={role}>C</Text>
          <ThemedText variant="h1" heading accessibilityRole={role}>D</ThemedText>
        `)
      ).toEqual([
        ['A', 'unknown'],
        ['B', 'unknown'],
        ['C', 'unknown'],
        ['D', 'unknown'],
      ]);
    });
  });
});
