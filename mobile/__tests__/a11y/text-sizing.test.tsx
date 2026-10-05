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
import {
  MOBILE_ROOT,
  jsxAttributeValue,
  jsxAttributes,
  lineOf,
  literalAttribute,
  parseTsx,
  readSource,
  sourceFiles,
  tagNameOf,
  walkJsx,
} from '../helpers/source-files';
import type { JsxAttributeValue, JsxNode } from '../helpers/source-files';

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

/** Directories of app code (everything but tests, scripts and assets). */
const APP_CODE_DIRS = ['app', 'components', 'config', 'hooks', 'i18n', 'services', 'store', 'theme', 'utils'];

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

const flat = (style: StyleProp<ViewStyle & TextStyle>): ViewStyle & TextStyle =>
  StyleSheet.flatten(style) ?? {};

const isTrueLiteral = (value: JsxAttributeValue): boolean =>
  value.kind === 'true' || (value.kind === 'literal' && value.value === true);

/**
 * Every place in `text` that can turn font scaling off: an `allowFontScaling`
 * prop, style key or property assignment whose value is not a literal `true`
 * (a variable, a spread object, `false`), and any `defaultProps` use (the
 * old `Text.defaultProps.allowFontScaling = false` switch). Read from the AST,
 * so comments that mention the prop do not count.
 */
function fontScalingOffenders(fileName: string, text: string): string[] {
  const source = parseTsx(fileName, text);
  const findings: string[] = [];
  const report = (node: ts.Node) => findings.push(`${fileName}:${lineOf(source, node)} ${node.getText()}`);
  const isTrue = (expression: ts.Expression | undefined) => expression?.kind === ts.SyntaxKind.TrueKeyword;

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'allowFontScaling') {
      if (!isTrueLiteral(jsxAttributeValue(node))) report(node);
    } else if (ts.isPropertyAssignment(node) && node.name.getText() === 'allowFontScaling') {
      if (!isTrue(node.initializer)) report(node);
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.getText() === 'allowFontScaling') {
      report(node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left.getText();
      if (/\ballowFontScaling$/.test(target) && !isTrue(node.right)) report(node);
    } else if (ts.isIdentifier(node) && node.text === 'defaultProps') {
      report(node.parent);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** The properties of one entry of the file's `StyleSheet.create({...})`, by key. */
function styleSheetEntry(source: ts.SourceFile, key: string): Map<string, ts.Expression> {
  const result = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'StyleSheet.create' &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const entry of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(entry) &&
          entry.name.getText() === key &&
          ts.isObjectLiteralExpression(entry.initializer)
        ) {
          for (const property of entry.initializer.properties) {
            if (ts.isPropertyAssignment(property)) result.set(property.name.getText(), property.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

const numberOf = (expression: ts.Expression | undefined): number =>
  expression && ts.isNumericLiteral(expression) ? Number(expression.text) : NaN;

/** The nearest ancestor of `node` that is a JSX element named `tag`. */
function enclosingElement(node: ts.Node, tag: string): JsxNode | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) && tagNameOf(current) === tag) {
      return current;
    }
  }
  return undefined;
}

/**
 * The identifiers a label's render guard requires to be false: for
 * `{isFocused && !isTrackTab && (<Label />)}` that is `isTrackTab`.
 */
function negatedGuards(label: ts.Node, stop: ts.Node): Set<string> {
  const names = new Set<string>();
  for (let current = label.parent; current && current !== stop; current = current.parent) {
    if (ts.isJsxExpression(current) && current.expression) {
      const collect = (node: ts.Node): void => {
        if (
          ts.isPrefixUnaryExpression(node) &&
          node.operator === ts.SyntaxKind.ExclamationToken &&
          ts.isIdentifier(node.operand)
        ) {
          names.add(node.operand.text);
        }
        if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) ts.forEachChild(node, collect);
      };
      collect(current.expression);
      break;
    }
  }
  return names;
}

/** Whether `node` sits in the `whenTrue` branch of a `cond ? a : b` on one of `names`, below `stop`. */
function onlyWhen(node: ts.Node, names: Set<string>, stop: ts.Node): boolean {
  for (let child = node, current = node.parent; current && current !== stop; child = current, current = current.parent) {
    if (
      ts.isConditionalExpression(current) &&
      ts.isIdentifier(current.condition) &&
      names.has(current.condition.text) &&
      current.whenTrue === child
    ) {
      return true;
    }
  }
  return false;
}

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
    const files = APP_CODE_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx']));
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((file) => {
      const relative = path.relative(MOBILE_ROOT, file);
      return fontScalingOffenders(relative, readSource(relative));
    });
    expect(offenders).toEqual([]);
  });

  it('catches every way of turning font scaling off', () => {
    const offenders = fontScalingOffenders(
      'sample.tsx',
      `
      // A comment that mentions allowFontScaling={false} is not code.
      const a = <Text allowFontScaling={false}>A</Text>;
      const b = <Text allowFontScaling={scales}>B</Text>;
      const c = <Text {...{ allowFontScaling: false }}>C</Text>;
      const d = { allowFontScaling };
      Text.defaultProps = Text.defaultProps || {};
      settings.allowFontScaling = false;
      const ok = <Text allowFontScaling>OK</Text>;
      const ok2 = <Text allowFontScaling={true} style={{ allowFontScaling: true }}>OK</Text>;
      `
    );
    expect(offenders.map((finding) => finding.split(' ')[0])).toEqual([
      'sample.tsx:3',
      'sample.tsx:4',
      'sample.tsx:5',
      'sample.tsx:6',
      'sample.tsx:7',
      'sample.tsx:7',
      'sample.tsx:8',
    ]);
  });

  describe('fixed heights in the components #776 names', () => {
    it.each(Object.keys(FIXED_HEIGHT_ALLOWLIST))('%s has no unlisted fixed height', (file) => {
      const allowed = FIXED_HEIGHT_ALLOWLIST[file];
      const findings = readSource(file)
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => /(^|[^A-Za-z])height\s*:/.test(line))
        .filter(({ line }) => !allowed.some((entry) => line === entry.match))
        .map(({ line, number }) => `${file}:${number} ${line}`);
      expect(findings).toEqual([]);
    });

    it('has no stale allowlist entry', () => {
      const stale = Object.entries(FIXED_HEIGHT_ALLOWLIST).flatMap(([file, entries]) => {
        const lines = readSource(file)
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
    it('caps the focused label and fits it with its own icon inside TAB_BAR_HEIGHT', () => {
      const source = parseTsx('app/(tabs)/_layout.tsx', readSource('app/(tabs)/_layout.tsx'));
      const labels: JsxNode[] = [];
      walkJsx(source, null, (node) => {
        if (tagNameOf(node) === 'Animated.Text') labels.push(node);
        return null;
      });
      expect(labels).toHaveLength(1);
      const [label] = labels;
      expect(jsxAttributes(label).get('maxFontSizeMultiplier')).toEqual({
        kind: 'expression',
        text: 'MAX_FONT_SCALE.fixedControl',
      });

      // The icon drawn with this label: an Ionicons in the same tab item that is
      // not confined to a branch the label's guard rules out (the Track button).
      const tabItem = enclosingElement(label, 'TouchableOpacity');
      expect(tabItem).toBeDefined();
      const guards = negatedGuards(label, tabItem as ts.Node);
      expect(guards.size).toBeGreaterThan(0);
      const icons: JsxNode[] = [];
      walkJsx(tabItem as ts.Node, null, (node) => {
        if (tagNameOf(node) === 'Ionicons' && !onlyWhen(node, guards, tabItem as ts.Node)) icons.push(node);
        return null;
      });
      expect(icons).toHaveLength(1);
      const iconSize = literalAttribute(jsxAttributes(icons[0]), 'size');
      expect(typeof iconSize).toBe('number');

      const tabLabel = styleSheetEntry(source, 'tabLabel');
      const lineHeight = numberOf(tabLabel.get('lineHeight'));
      const marginTop = numberOf(tabLabel.get('marginTop'));
      expect(lineHeight).toBeGreaterThan(0);
      expect(marginTop).toBeGreaterThanOrEqual(0);
      expect((iconSize as number) + marginTop + lineHeight * MAX_FONT_SCALE.fixedControl).toBeLessThanOrEqual(
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
      expect(toastDuration('Copied', 1200)).toBe(1200);
      expect(toastDuration('Saved', 5000)).toBe(5000);
      expect(toastDuration('x'.repeat(100), 1200)).toBe(1200 + 40 * 40);
      expect(toastDuration('x'.repeat(160))).toBe(7000);
      expect(toastDuration('x'.repeat(1000))).toBe(8000);
      expect(toastDuration('x'.repeat(1000), 10000)).toBe(10000);
    });
  });
});
