/**
 * Guard: text in fixed-size controls survives accessibility text sizes (#776).
 *
 * The app never turns font scaling off: every `Text` grows with the iOS/Android
 * text size (1.786x at the first accessibility size, 3.571x at the largest).
 * Where a control's size is fixed on purpose (the tracker's shot grid, the tab
 * bar), its text caps its scaling with `maxFontSizeMultiplier`
 * (`theme/typography.ts#MAX_FONT_SCALE`); everywhere else the container grows
 * (`minHeight`, no one-line clamp on user data).
 *
 * Jest does no layout, so the "fits" checks below are arithmetic on the real
 * line heights at the cap, not a measured render. A device or simulator at the
 * largest text size is the final check (docs/testing/e2e-test-plan-v2.0.md).
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import ts from 'typescript';

import { BUTTON_HEIGHT, ShotButtons } from '../../components/game/ShotButtons';
import { BoxScoreTable } from '../../components/stats/BoxScoreTable';
import { TOAST_MAX_LINES, ToastProvider, toastDuration, useToast } from '../../components/Toast';
import { TAB_BAR_HEIGHT } from '../../hooks/useTabBarPadding';
import { MAX_FONT_SCALE } from '../../theme/typography';
import type { PlayerGameStats, TeamGameStats } from '../../types/stats';
import { MOBILE_ROOT, sourceFiles } from '../helpers/source-files';

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#06C',
      border: '#ccc',
      text: '#000',
      textSecondary: '#666',
      success: '#0A0',
      error: '#A00',
      info: '#06C',
      card: '#fff',
    },
    colorScheme: 'light',
  }),
}));

/** The largest iOS accessibility text size multiplier. */
const LARGEST_IOS_SCALE = 3.571;

/** The components #776 names. A fixed `height:` in them needs a reason here. */
const FIXED_HEIGHT_ALLOWLIST: Record<string, { match: string; reason: string }[]> = {
  'components/game/ShotButtons.tsx': [],
  'components/Toast.tsx': [],
  'components/stats/BoxScoreTable.tsx': [{ match: 'height: 1,', reason: 'divider line, no text' }],
  'app/(tabs)/_layout.tsx': [
    {
      match: 'height: TAB_BAR_HEIGHT + insets.bottom,',
      reason: 'bar footprint that useTabBarPadding pads by; its label is capped',
    },
    { match: 'height: TAB_BAR_HEIGHT,', reason: 'tab item; its label is capped and its line height bounded' },
    { match: 'height: 40,', reason: 'focus pill behind the icon, no text' },
    { match: 'height: 52,', reason: 'Track button circle, icon only' },
    { match: 'shadowOffset: { width: 0, height: 4 },', reason: 'shadow offset, not a size' },
  ],
};

function read(relative: string): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, relative), 'utf8');
}

const flat = (style: StyleProp<ViewStyle & TextStyle>): ViewStyle & TextStyle =>
  StyleSheet.flatten(style) ?? {};

const stats = {
  points: 24,
  rebounds: 8,
  offensiveRebounds: 2,
  defensiveRebounds: 6,
  assists: 5,
  steals: 3,
  blocks: 1,
  turnovers: 2,
  fouls: 4,
  fieldGoalsMade: 12,
  fieldGoalsAttempted: 18,
  fieldGoalPercentage: 66.7,
  threePointersMade: 10,
  threePointersAttempted: 14,
  threePointPercentage: 71.4,
  freeThrowsMade: 10,
  freeThrowsAttempted: 10,
  freeThrowPercentage: 100,
};
const player: PlayerGameStats = {
  ...stats,
  playerId: 'p1',
  playerName: 'Maximiliana Featherstonehaugh',
  jerseyNumber: 0,
  position: 'Guard',
};
const team = { ...stats, teamId: 't1', teamName: 'Hawks' } as TeamGameStats;

describe('text sizing at accessibility text sizes', () => {
  it('never turns font scaling off', () => {
    const files = ['app', 'components'].flatMap((dir) =>
      sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx'])
    );
    const offenders = files.filter((file) => /allowFontScaling\s*=\s*\{\s*false\s*\}/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  describe('fixed heights in the components #776 names', () => {
    it.each(Object.keys(FIXED_HEIGHT_ALLOWLIST))('%s has no unlisted fixed height', (file) => {
      const allowed = FIXED_HEIGHT_ALLOWLIST[file];
      const findings = read(file)
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => /(^|[^A-Za-z])height\s*:/.test(line))
        .filter(({ line }) => !allowed.some((entry) => line === entry.match))
        .map(({ line, number }) => `${file}:${number} ${line}`);
      expect(findings).toEqual([]);
    });

    it('has no stale allowlist entry', () => {
      const stale = Object.entries(FIXED_HEIGHT_ALLOWLIST).flatMap(([file, entries]) => {
        const lines = read(file)
          .split('\n')
          .map((line) => line.trim());
        return entries.filter((entry) => !lines.includes(entry.match)).map((entry) => `${file} ${entry.match}`);
      });
      expect(stale).toEqual([]);
    });
  });

  describe('ShotButtons', () => {
    it('caps both labels and lets the button grow from its default height', () => {
      const { getByLabelText, getAllByText } = render(<ShotButtons onShot={jest.fn()} />);

      const button = flat(getByLabelText('2-point shot made').props.style);
      expect(button.minHeight).toBe(BUTTON_HEIGHT);
      expect(button.height).toBeUndefined();

      const labels = [...getAllByText('2PT'), ...getAllByText('MADE')];
      for (const label of labels) {
        expect(label.props.maxFontSizeMultiplier).toBe(MAX_FONT_SCALE.fixedControl);
      }

      // Both lines at the cap fit the default height, so the grid does not grow.
      const [points, made] = [getAllByText('2PT')[0], getAllByText('MADE')[0]];
      const pointsLine = flat(points.props.style).lineHeight ?? NaN;
      const madeLine = flat(made.props.style).lineHeight ?? NaN;
      const capped = (pointsLine + madeLine) * Math.min(LARGEST_IOS_SCALE, MAX_FONT_SCALE.fixedControl);
      expect(capped).toBeLessThanOrEqual(BUTTON_HEIGHT);
    });
  });

  describe('tab bar label', () => {
    const source = read('app/(tabs)/_layout.tsx');

    it('caps the focused label and bounds its line height inside TAB_BAR_HEIGHT', () => {
      const file = ts.createSourceFile('layout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const labels: Map<string, string>[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) && node.tagName.getText() === 'Animated.Text') {
          const attributes = new Map<string, string>();
          for (const a of node.attributes.properties) {
            if (ts.isJsxAttribute(a)) attributes.set(a.name.getText(), a.initializer?.getText() ?? 'true');
          }
          labels.push(attributes);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);

      expect(labels).toHaveLength(1);
      expect(labels[0].get('maxFontSizeMultiplier')).toBe('{MAX_FONT_SCALE.fixedControl}');

      const tabLabel = /tabLabel:\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
      const lineHeight = Number(/lineHeight:\s*(\d+)/.exec(tabLabel)?.[1]);
      const marginTop = Number(/marginTop:\s*(\d+)/.exec(tabLabel)?.[1]);
      const ICON_SIZE = 24;
      expect(source).toContain(`size={${ICON_SIZE}}`);
      expect(ICON_SIZE + marginTop + lineHeight * MAX_FONT_SCALE.fixedControl).toBeLessThanOrEqual(
        TAB_BAR_HEIGHT
      );
    });
  });

  describe('BoxScoreTable', () => {
    afterEach(() => jest.restoreAllMocks());

    it('never clamps a data cell and caps every cell', () => {
      const { getByText, getAllByText } = render(<BoxScoreTable players={[player]} teamStats={team} />);

      for (const value of ['12-18', '66.7', '10-14', '100.0', '#0 Maximiliana Featherstonehaugh']) {
        const cell = getAllByText(value)[0];
        expect(cell.props.numberOfLines).toBeUndefined();
        expect(cell.props.maxFontSizeMultiplier).toBe(MAX_FONT_SCALE.denseTable);
      }
      // The short column labels keep one line.
      expect(getByText('FG').props.numberOfLines).toBe(1);
    });

    it('widens every column with the text size, up to the cap, the same on every row', () => {
      const real = Dimensions.get('window');
      const widthsAt = (fontScale: number): number[] => {
        jest.spyOn(Dimensions, 'get').mockReturnValue({ ...real, fontScale });
        const { getAllByText, unmount } = render(<BoxScoreTable players={[player]} teamStats={team} />);
        // Player row and team row carry the same FG value: their cells must match.
        const widths = getAllByText('12-18').map((cell) => {
          // Walk up from the text to the cell View that carries the width.
          let node = cell.parent;
          while (node && flat(node.props.style).width === undefined) node = node.parent;
          return flat(node?.props.style).width as number;
        });
        unmount();
        jest.restoreAllMocks();
        return widths;
      };

      const [base] = widthsAt(1);
      const scaled = widthsAt(1.2);
      const largest = widthsAt(LARGEST_IOS_SCALE);

      expect(base).toBeGreaterThan(0);
      expect(scaled).toEqual([base * 1.2, base * 1.2]);
      expect(largest).toEqual([base * MAX_FONT_SCALE.denseTable, base * MAX_FONT_SCALE.denseTable]);
    });
  });

  describe('Toast', () => {
    const LONG =
      'Your free plan includes up to three teams. Upgrade to add another team, or archive one ' +
      'of your existing teams from its settings page and then try again.';

    function Trigger() {
      const { showToast } = useToast();
      return (
        <Text testID="fire" onPress={() => showToast(LONG, 'error')}>
          fire
        </Text>
      );
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      // Restore the setTimeout spy before the real timers come back.
      jest.restoreAllMocks();
      jest.useRealTimers();
    });

    it('gives a ~160-character message four lines and the time to read it', () => {
      expect(LONG.length).toBeGreaterThanOrEqual(150);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const { getByTestId, getByText } = render(
        <ToastProvider>
          <Trigger />
        </ToastProvider>
      );
      act(() => {
        fireEvent.press(getByTestId('fire'));
      });

      expect(getByText(LONG).props.numberOfLines).toBe(TOAST_MAX_LINES);
      expect(TOAST_MAX_LINES).toBeGreaterThanOrEqual(4);
      // The dismiss timer runs for the extended duration, not the 3s default.
      expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toContain(toastDuration(LONG));
      expect(toastDuration(LONG)).toBeGreaterThan(3000);
    });

    it('keeps short messages at the requested duration and caps long ones', () => {
      expect(toastDuration('Saved')).toBe(3000);
      expect(toastDuration('Saved', 5000)).toBe(5000);
      expect(toastDuration('x'.repeat(160))).toBe(7000);
      expect(toastDuration('x'.repeat(1000))).toBe(8000);
      expect(toastDuration('x'.repeat(1000), 10000)).toBe(10000);
    });
  });
});
