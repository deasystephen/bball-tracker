/**
 * Guard: icon buttons are 44pt touch targets (#772).
 *
 * An icon-only pressable (`TouchableOpacity`/`Pressable` whose only child is
 * an icon) is as big as its glyph plus padding. A 22pt icon with 4pt padding
 * is a 30pt target, which a coach operating the app one-handed misses. This
 * reads the source of `app/` and `components/` and works out each icon
 * button's size from the icon's `size` and the `StyleSheet.create` entries its
 * `style` names (`padding*`, `width`/`height`, `minWidth`/`minHeight`, with
 * `spacing.*` tokens and `MIN_TOUCH_TARGET` resolved), plus its `hitSlop`.
 * It fails unless the result reaches 44 x 44.
 *
 * `hitSlop` is a literal `{ top, bottom, left, right }`, a
 * `utils/touch-target.ts#touchTargetHitSlop(<drawn size>)` call, or a constant
 * holding one (in the file or exported from `utils/touch-target.ts`, such as
 * `HEADER_ICON_HIT_SLOP`). For the call the guard checks that the size passed
 * is no larger than the size it computed, so a slop written for a 40pt button
 * cannot sit on a 30pt one.
 *
 * A size it cannot resolve (a computed icon size, a style built at runtime, a
 * `hitSlop` it cannot read) is reported too.
 *
 * Two icon buttons side by side with no gap take `minWidth`/`minHeight` instead
 * of `hitSlop`: overlapping slop hands the later sibling taps on the earlier.
 *
 * Text controls (pills, chips, the UNDO and RSVP buttons) take
 * `minHeight: MIN_TOUCH_TARGET`; their render tests assert it.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { MOBILE_ROOT, sourceFiles } from '../helpers/source-files';
import { spacing } from '../../theme/spacing';
import { MIN_TOUCH_TARGET } from '../../utils/touch-target';

const SCANNED_DIRS = ['app', 'components'];
const PRESSABLES = new Set(['TouchableOpacity', 'TouchableHighlight', 'Pressable']);
const ICONS = new Set(['Ionicons', 'MaterialIcons', 'MaterialCommunityIcons', 'FontAwesome', 'Feather']);

interface SizeFinding {
  file: string;
  line: number;
  size: string;
}

type Style = Record<string, number | undefined>;

function attribute(opening: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name
  );
}

function initializerExpression(attr: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const init = attr?.initializer;
  if (!init) return undefined;
  if (ts.isJsxExpression(init)) return init.expression;
  return init;
}

/** `const X = <expr>` declarations of `utils/touch-target.ts`, visible to every scanned file. */
function sharedConstants(): Map<string, ts.Expression> {
  const file = path.join(MOBILE_ROOT, 'utils', 'touch-target.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      result.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return result;
}

const SHARED_CONSTANTS = sharedConstants();

export function findSmallIconButtons(fileName: string, text: string): SizeFinding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = new Map<string, ts.Expression>(SHARED_CONSTANTS);
  const sheets = new Map<string, ts.ObjectLiteralExpression>();

  // Module- and function-level `const X = <expr>` and `StyleSheet.create({...})` entries.
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
      const init = node.initializer;
      if (
        ts.isCallExpression(init) &&
        init.expression.getText() === 'StyleSheet.create' &&
        init.arguments[0] &&
        ts.isObjectLiteralExpression(init.arguments[0])
      ) {
        for (const prop of init.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
            sheets.set(`${node.name.text}.${prop.name.getText()}`, prop.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const evaluate = (expr: ts.Expression | undefined, depth = 0): number | undefined => {
    if (!expr || depth > 5) return undefined;
    if (ts.isNumericLiteral(expr)) return Number(expr.text);
    if (ts.isParenthesizedExpression(expr)) return evaluate(expr.expression, depth + 1);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
      const value = evaluate(expr.operand, depth + 1);
      return value === undefined ? undefined : -value;
    }
    if (ts.isBinaryExpression(expr)) {
      const left = evaluate(expr.left, depth + 1);
      const right = evaluate(expr.right, depth + 1);
      if (left === undefined || right === undefined) return undefined;
      switch (expr.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return left + right;
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        default:
          return undefined;
      }
    }
    if (ts.isPropertyAccessExpression(expr) && expr.expression.getText() === 'spacing') {
      return spacing[expr.name.text as keyof typeof spacing];
    }
    if (ts.isIdentifier(expr)) {
      if (expr.text === 'MIN_TOUCH_TARGET') return MIN_TOUCH_TARGET;
      return evaluate(constants.get(expr.text), depth + 1);
    }
    return undefined;
  };

  /** Every style object literal an expression names; `null` when part of it is opaque. */
  const styleObjects = (expr: ts.Expression | undefined): ts.ObjectLiteralExpression[] | null => {
    if (!expr) return [];
    if (ts.isArrayLiteralExpression(expr)) {
      const parts = expr.elements.map((e) => styleObjects(e));
      return parts.includes(null) ? null : (parts as ts.ObjectLiteralExpression[][]).flat();
    }
    if (ts.isObjectLiteralExpression(expr)) return [expr];
    if (ts.isPropertyAccessExpression(expr)) {
      const sheet = sheets.get(expr.getText());
      return sheet ? [sheet] : null;
    }
    // `cond && styles.x`: only the guarded entry can add size.
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return styleObjects(expr.right);
    }
    return null;
  };

  const resolveStyle = (objects: ts.ObjectLiteralExpression[]): Style => {
    const style: Style = {};
    for (const object of objects) {
      for (const prop of object.properties) {
        if (ts.isPropertyAssignment(prop)) {
          style[prop.name.getText()] = evaluate(prop.initializer);
        }
      }
    }
    return style;
  };

  /** The slop on each side; `null` when it cannot be read. */
  const hitSlopOf = (
    expr: ts.Expression | undefined,
    width: number,
    height: number
  ): { top: number; bottom: number; left: number; right: number } | null => {
    const none = { top: 0, bottom: 0, left: 0, right: 0 };
    if (!expr) return none;
    const target = ts.isIdentifier(expr) ? constants.get(expr.text) : expr;
    if (!target) return null;
    if (ts.isNumericLiteral(target)) {
      const n = Number(target.text);
      return { top: n, bottom: n, left: n, right: n };
    }
    if (ts.isObjectLiteralExpression(target)) {
      const sides = { ...none };
      for (const prop of target.properties) {
        if (!ts.isPropertyAssignment(prop)) return null;
        const value = evaluate(prop.initializer);
        const key = prop.name.getText() as keyof typeof sides;
        if (value === undefined || !(key in sides)) return null;
        sides[key] = value;
      }
      return sides;
    }
    if (ts.isCallExpression(target) && target.expression.getText() === 'touchTargetHitSlop') {
      const [w, h] = target.arguments.map((a) => evaluate(a));
      if (w === undefined || (target.arguments.length > 1 && h === undefined)) return null;
      // The helper pads the size it is told; trust it only when told no more than the real size.
      const told = { w, h: h ?? w };
      if (told.w > width || told.h > height) return none;
      const v = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - told.h) / 2));
      const hz = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - told.w) / 2));
      return { top: v, bottom: v, left: hz, right: hz };
    }
    return null;
  };

  const findings: SizeFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && PRESSABLES.has(node.openingElement.tagName.getText())) {
      const opening = node.openingElement;
      const children = node.children.filter((c) => !(ts.isJsxText(c) && c.text.trim() === ''));
      const only = children.length === 1 ? children[0] : undefined;
      const icon = only && (ts.isJsxSelfClosingElement(only) ? only : ts.isJsxElement(only) ? only.openingElement : undefined);
      if (
        icon &&
        ICONS.has(icon.tagName.getText()) &&
        attribute(opening, 'accessible')?.initializer?.getText() !== '{false}'
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const iconSize = evaluate(initializerExpression(attribute(icon, 'size')));
        const objects = styleObjects(initializerExpression(attribute(opening, 'style')));
        if (iconSize === undefined || objects === null) {
          findings.push({ file: fileName, line, size: 'unresolved' });
        } else {
          const s = resolveStyle(objects);
          const pad = (side: number | undefined, axis: number | undefined): number => side ?? axis ?? s.padding ?? 0;
          const drawnWidth = iconSize + pad(s.paddingLeft, s.paddingHorizontal) + pad(s.paddingRight, s.paddingHorizontal);
          const drawnHeight = iconSize + pad(s.paddingTop, s.paddingVertical) + pad(s.paddingBottom, s.paddingVertical);
          const width = Math.max(drawnWidth, s.width ?? 0, s.minWidth ?? 0);
          const height = Math.max(drawnHeight, s.height ?? 0, s.minHeight ?? 0);
          const slop = hitSlopOf(initializerExpression(attribute(opening, 'hitSlop')), width, height);
          if (slop === null) {
            findings.push({ file: fileName, line, size: 'unresolved hitSlop' });
          } else {
            const reachW = width + slop.left + slop.right;
            const reachH = height + slop.top + slop.bottom;
            if (reachW < MIN_TOUCH_TARGET || reachH < MIN_TOUCH_TARGET) {
              findings.push({ file: fileName, line, size: `${reachW}x${reachH}` });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('icon button touch targets', () => {
  it('finds none under 44pt in the app', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.tsx']));
    expect(files.length).toBeGreaterThan(50);

    const findings = files.flatMap((file) =>
      findSmallIconButtons(path.relative(MOBILE_ROOT, file), fs.readFileSync(file, 'utf8'))
    );

    expect(findings.map((f) => `${f.file}:${f.line} icon button is ${f.size}`)).toEqual([]);
  });

  describe('the scanner', () => {
    const sheet = (entry: string) => `const styles = StyleSheet.create({ button: ${entry}, header: { padding: spacing.sm } });`;

    it('reports a 22pt icon with spacing.xs padding: the team hero edit/delete defect', () => {
      const findings = findSmallIconButtons(
        'sample.tsx',
        `
        const A = () => (
          <TouchableOpacity style={styles.button} onPress={edit}>
            <Ionicons name="create-outline" size={22} />
          </TouchableOpacity>
        );
        ${sheet('{ padding: spacing.xs }')}
        `
      );

      expect(findings).toEqual([{ file: 'sample.tsx', line: 3, size: '30x30' }]);
    });

    it('accepts a hitSlop, a 44pt minimum and enough padding', () => {
      const button = (props: string, size = 24) =>
        `<TouchableOpacity ${props} onPress={go}><Ionicons name="x" size={${size}} /></TouchableOpacity>`;
      const findings = findSmallIconButtons(
        'sample.tsx',
        `
        const ICON = 22;
        const A = () => (
          <View>
            ${button('style={styles.button} hitSlop={touchTargetHitSlop(30)}', 22)}
            ${button('style={styles.button} hitSlop={touchTargetHitSlop(ICON + 2 * spacing.xs)}', 22)}
            ${button('style={styles.button} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}')}
            ${button('style={styles.header} hitSlop={HEADER_ICON_HIT_SLOP}')}
            ${button('style={[styles.button, { minWidth: MIN_TOUCH_TARGET, minHeight: MIN_TOUCH_TARGET }]}')}
            ${button('style={{ padding: spacing.sm + 2 }}')}
            ${button('style={{ width: 44, height: 44 }}', 0)}
          </View>
        );
        ${sheet('{ padding: spacing.xs }')}
        `
      );

      expect(findings).toEqual([]);
    });

    it('reports a hitSlop written for a bigger button than the one it sits on', () => {
      const findings = findSmallIconButtons(
        'sample.tsx',
        `
        const A = () => (
          <TouchableOpacity style={styles.button} hitSlop={touchTargetHitSlop(40)} onPress={go}>
            <Ionicons name="x" size={22} />
          </TouchableOpacity>
        );
        ${sheet('{ padding: spacing.xs }')}
        `
      );

      expect(findings).toEqual([{ file: 'sample.tsx', line: 3, size: '30x30' }]);
    });

    it('reports the shared header slop on a button smaller than a header icon button', () => {
      const findings = findSmallIconButtons(
        'sample.tsx',
        `
        const A = () => (
          <TouchableOpacity style={styles.button} hitSlop={HEADER_ICON_HIT_SLOP} onPress={go}>
            <Ionicons name="x" size={22} />
          </TouchableOpacity>
        );
        ${sheet('{ padding: spacing.xs }')}
        `
      );

      expect(findings).toEqual([{ file: 'sample.tsx', line: 3, size: '30x30' }]);
    });

    it('reports a size it cannot work out', () => {
      const findings = findSmallIconButtons(
        'sample.tsx',
        `const A = () => <Pressable style={makeStyle()} onPress={go}><Ionicons name="x" size={24} /></Pressable>;`
      );

      expect(findings).toEqual([{ file: 'sample.tsx', line: 1, size: 'unresolved' }]);
    });
  });
});
