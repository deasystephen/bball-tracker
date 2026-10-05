/**
 * Guard: screen titles and section headings carry the header role (#775).
 *
 * Every navigator hides the native header, so each screen draws its own title
 * as a `ThemedText`. VoiceOver's Headings rotor and TalkBack's heading
 * navigation find only elements with `accessibilityRole="header"`; without it
 * a screen reader user swipes through every row to reach a section.
 *
 * `ThemedText`'s `heading` prop sets the role. It is opt-in, never a variant
 * default, because the heading variants also render numbers (scores, record
 * counts, stat values) that must not be announced as headings.
 *
 * Rules, read from the source:
 * 1. Every `<ThemedText variant="h1" | "h2">` under `app/` is a heading, unless
 *    it renders a value listed in `VALUE_ALLOWLIST` (with the reason). A value
 *    listed there must never be marked as a heading.
 * 2. Every screen file under `app/` exposes at least one heading, unless it is
 *    listed in `SCREENS_WITHOUT_TITLE` (with the reason).
 * 3. The shared components that draw a title (`HEADING_COMPONENTS`) mark it;
 *    the ones that only draw numbers (`VALUE_COMPONENTS`) mark nothing.
 *
 * To fix a finding: add `heading` to the title (`<ThemedText variant="h2"
 * heading>`), or `accessibilityRole="header"` on a bare `Text`.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { MOBILE_ROOT, sourceFiles } from '../helpers/source-files';

/** h1/h2 elements under `app/` that render a value, not a title. */
const VALUE_ALLOWLIST: { file: string; children: RegExp; reason: string }[] = [
  { file: 'app/(tabs)/games.tsx', children: /^\{item\.(home|away)Score\}$/, reason: 'live game card score' },
  { file: 'app/(tabs)/home.tsx', children: /^\{liveGame\.(home|away)Score\}$/, reason: 'live game score' },
  { file: 'app/(tabs)/stats.tsx', children: /^\{seasonStats\.(wins|losses|ties)\}$/, reason: 'season record counts' },
  { file: 'app/(tabs)/stats.tsx', children: /^-$/, reason: 'separator between record counts' },
  { file: 'app/(tabs)/stats.tsx', children: /^\{topScorer\.pointsPerGame\.toFixed\(1\)\}$/, reason: 'team leader points per game' },
  { file: 'app/(tabs)/teams.tsx', children: /charAt\(0\)/, reason: 'team initial in the card avatar' },
  { file: 'app/games/[id]/stats.tsx', children: /^\{boxScore\.game\.(home|away)Score\}$/, reason: 'final score' },
  { file: 'app/games/[id]/stats.tsx', children: /^\{boxScore\.team\.stats\.(points|rebounds|assists)\}$/, reason: 'team totals' },
  { file: 'app/players/[id]/stats.tsx', children: /charAt\(0\)/, reason: 'player initial in the avatar' },
  { file: 'app/teams/[id]/stats.tsx', children: /^\{seasonStats\.(wins|losses|ties)\}$/, reason: 'season record counts' },
  { file: 'app/teams/[id]/stats.tsx', children: /^-$/, reason: 'separator between record counts' },
  { file: 'app/teams/[id]/stats.tsx', children: /^\{seasonStats\.\w+Percentage\.toFixed\(1\)\}%$/, reason: 'shooting percentages' },
];

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
];

export interface TextElement {
  line: number;
  tag: string;
  variant: string | null;
  isHeading: boolean;
  children: string;
}

function attributesOf(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Map<string, string> {
  const result = new Map<string, string>();
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxAttribute(attribute)) {
      result.set(attribute.name.getText(), attribute.initializer?.getText() ?? 'true');
    }
  }
  return result;
}

/** Every JSX element in `text`, with its variant, whether it is a heading, and its children's source. */
export function textElements(fileName: string, text: string): TextElement[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: TextElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const attributes = attributesOf(opening);
      const tag = opening.tagName.getText();
      const role = attributes.get('accessibilityRole');
      const heading = attributes.get('heading');
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        tag,
        variant: attributes.get('variant')?.replace(/^"|"$/g, '') ?? null,
        isHeading:
          role === '"header"' ||
          role === "'header'" ||
          (tag === 'ThemedText' && heading !== undefined && heading !== '{false}'),
        children: ts.isJsxElement(node)
          ? node.children
              .map((child) => child.getText())
              .join('')
              .replace(/\s+/g, ' ')
              .trim()
          : '',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, relative), 'utf8');
}

const isTitleVariant = (el: TextElement): boolean =>
  el.tag === 'ThemedText' && (el.variant === 'h1' || el.variant === 'h2');

function valueEntryFor(file: string, el: TextElement) {
  return VALUE_ALLOWLIST.find((entry) => entry.file === file && entry.children.test(el.children));
}

describe('heading roles', () => {
  const screens = sourceFiles(path.join(MOBILE_ROOT, 'app'), ['.tsx']).map((file) =>
    path.relative(MOBILE_ROOT, file)
  );
  const elementsByScreen = new Map(screens.map((file) => [file, textElements(file, read(file))]));

  it('scans the app', () => {
    // A guard that scans nothing passes for the wrong reason.
    expect(screens.length).toBeGreaterThan(30);
  });

  it('marks every h1/h2 under app/ as a heading unless it renders an allowlisted value', () => {
    const findings = screens.flatMap((file) =>
      (elementsByScreen.get(file) ?? [])
        .filter((el) => isTitleVariant(el) && !el.isHeading && !valueEntryFor(file, el))
        .map((el) => `${file}:${el.line} <ThemedText variant="${el.variant}">${el.children}`)
    );
    expect(findings).toEqual([]);
  });

  it('never marks an allowlisted value as a heading', () => {
    const findings = screens.flatMap((file) =>
      (elementsByScreen.get(file) ?? [])
        .filter((el) => el.isHeading && valueEntryFor(file, el))
        .map((el) => `${file}:${el.line} ${el.children}`)
    );
    expect(findings).toEqual([]);
  });

  it('has no stale value allowlist entry', () => {
    const stale = VALUE_ALLOWLIST.filter(
      (entry) =>
        !(elementsByScreen.get(entry.file) ?? []).some(
          (el) => isTitleVariant(el) && entry.children.test(el.children)
        )
    ).map((entry) => `${entry.file} ${entry.children}`);
    expect(stale).toEqual([]);
  });

  it('gives every screen at least one heading', () => {
    const missing = screens.filter(
      (file) => !(file in SCREENS_WITHOUT_TITLE) && !(elementsByScreen.get(file) ?? []).some((el) => el.isHeading)
    );
    expect(missing).toEqual([]);
  });

  it('has no stale entry for a screen without a title', () => {
    const stale = Object.keys(SCREENS_WITHOUT_TITLE).filter(
      (file) => !screens.includes(file) || (elementsByScreen.get(file) ?? []).some((el) => el.isHeading)
    );
    expect(stale).toEqual([]);
  });

  it.each(HEADING_COMPONENTS)('%s marks its title as a heading', (file) => {
    expect(textElements(file, read(file)).some((el) => el.isHeading)).toBe(true);
  });

  it.each(VALUE_COMPONENTS)('%s exposes no number as a heading', (file) => {
    expect(textElements(file, read(file)).filter((el) => el.isHeading)).toEqual([]);
  });

  describe('the scanner', () => {
    it('reads the heading prop and an explicit header role', () => {
      const elements = textElements(
        'sample.tsx',
        `
        const S = () => (
          <View>
            <ThemedText variant="h1" heading>Games</ThemedText>
            <Text accessibilityRole="header">Hooplings</Text>
            <ThemedText variant="h2" heading={false}>Off</ThemedText>
            <ThemedText variant="h2">{game.homeScore}</ThemedText>
          </View>
        );
        `
      );
      expect(
        elements.filter((el) => el.tag !== 'View').map((el) => [el.variant, el.isHeading, el.children])
      ).toEqual([
        ['h1', true, 'Games'],
        [null, true, 'Hooplings'],
        ['h2', false, 'Off'],
        ['h2', false, '{game.homeScore}'],
      ]);
    });
  });
});
