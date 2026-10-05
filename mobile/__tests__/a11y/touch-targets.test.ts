/**
 * Guard: icon buttons are 44pt touch targets (#772).
 *
 * An icon button is as big as its glyph plus padding. A 22pt icon with 4pt
 * padding is a 30pt target, which a coach operating the app one-handed
 * misses. This reads the source of `app/` and `components/` and checks every
 * pressable (`TouchableOpacity`, `TouchableHighlight`, `Pressable`) whose
 * first child is an icon, or that holds an icon and no text: the icon-only
 * buttons, and hand-sized ones with a second child such as the Home bell and
 * its badge or the print button and its label. It works out the button's
 * size from the icon's `size` and the `StyleSheet.create` entries its `style`
 * names (`padding*`, `width`/`height`, `minWidth`/`minHeight`, with
 * `spacing.*` tokens and `MIN_TOUCH_TARGET` resolved), plus its `hitSlop`,
 * and fails unless the result reaches 44 x 44. For a button with a second
 * child the icon is a lower bound, so it errs toward reporting.
 *
 * Names resolve the way the compiler resolves them: the nearest enclosing
 * block that declares the `const` (a component's body before the module),
 * then the module, then the exports of `utils/touch-target.ts`. Two
 * components that each declare `const ICON` are each checked with their own.
 *
 * `hitSlop` is a literal `{ top, bottom, left, right }`, a
 * `utils/touch-target.ts#touchTargetHitSlop(<drawn size>)` call, or a constant
 * holding one (such as `HEADER_ICON_HIT_SLOP`). For the call the guard checks
 * that the size passed is no larger than the size it computed, so a slop
 * written for a 40pt button cannot sit on a 30pt one; it names that case.
 *
 * A size it cannot resolve (a computed icon size, a style built at runtime, a
 * `hitSlop` it cannot read) is reported too.
 *
 * It also fails on a literal `44` for `minHeight`, `minWidth`, `height` or
 * `width` in any pressable's style: the minimum is `MIN_TOUCH_TARGET`.
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
const TEXT = new Set(['Text', 'ThemedText', 'Animated.Text']);
/** Elements that can sit beside an icon in a text-free button without setting its size. */
const NEUTRAL = new Set(['View', 'Animated.View']);
const SIZE_KEYS = new Set(['minHeight', 'minWidth', 'height', 'width']);

export interface SizeFinding {
  file: string;
  line: number;
  problem: string;
}

type Style = Record<string, number | undefined>;
type Sides = { top: number; bottom: number; left: number; right: number };

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

/** The `const` named `name` that `from` sees: nearest enclosing block first, then the module. */
function declaredConst(name: string, from: ts.Node): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
            return declaration.initializer;
          }
        }
      }
    }
  }
  return undefined;
}

const modules = new Map<string, ts.SourceFile | null>();

/** A mobile source module by absolute path (without extension), parsed once. */
function moduleAt(base: string): ts.SourceFile | null {
  if (!modules.has(base)) {
    const file = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find((f) => fs.existsSync(f));
    modules.set(
      base,
      file ? ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true) : null
    );
  }
  return modules.get(base) ?? null;
}

const SHARED_SOURCE = moduleAt(path.join(MOBILE_ROOT, 'utils', 'touch-target'));

/** The top-level `const` `name` of a module (its exports included). */
function moduleConst(module: ts.SourceFile | null, name: string): ts.Expression | undefined {
  return module?.statements[0] ? declaredConst(name, module.statements[0]) : undefined;
}

/**
 * A `const` visible at `from`: declared in an enclosing scope, else brought in
 * by a named relative import (`import { TAB_BAR_HEIGHT } from '../../hooks/…'`),
 * else exported by `utils/touch-target.ts` (for code that is not a real file).
 */
function lookup(name: string, from: ts.Node): ts.Expression | undefined {
  const local = declaredConst(name, from);
  if (local) return local;
  const source = from.getSourceFile();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!specifier.startsWith('.') || !bindings || !ts.isNamedImports(bindings)) continue;
    const imported = bindings.elements.find((e) => e.name.text === name);
    if (imported) {
      const base = path.resolve(MOBILE_ROOT, path.dirname(source.fileName), specifier);
      return moduleConst(moduleAt(base), (imported.propertyName ?? imported.name).text);
    }
  }
  return moduleConst(SHARED_SOURCE, name);
}

function evaluate(expr: ts.Expression | undefined, depth = 0): number | undefined {
  if (!expr || depth > 8) return undefined;
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
    return evaluate(lookup(expr.text, expr), depth + 1);
  }
  return undefined;
}

/** `styles.x` resolved through the `const styles = StyleSheet.create({...})` in scope. */
function sheetEntry(access: ts.PropertyAccessExpression): ts.ObjectLiteralExpression | undefined {
  if (!ts.isIdentifier(access.expression)) return undefined;
  const sheet = lookup(access.expression.text, access);
  if (
    !sheet ||
    !ts.isCallExpression(sheet) ||
    sheet.expression.getText() !== 'StyleSheet.create' ||
    !sheet.arguments[0] ||
    !ts.isObjectLiteralExpression(sheet.arguments[0])
  ) {
    return undefined;
  }
  for (const prop of sheet.arguments[0].properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      prop.name.getText() === access.name.text &&
      ts.isObjectLiteralExpression(prop.initializer)
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

/**
 * The style object literals an expression names. `opaque` is set when part of
 * it cannot be read (a prop, a call), so a size built from it is unknown.
 */
function styleObjects(expr: ts.Expression | undefined): { objects: ts.ObjectLiteralExpression[]; opaque: boolean } {
  if (!expr) return { objects: [], opaque: false };
  if (ts.isArrayLiteralExpression(expr)) {
    const parts = expr.elements.map((e) => styleObjects(e));
    return { objects: parts.flatMap((p) => p.objects), opaque: parts.some((p) => p.opaque) };
  }
  if (ts.isObjectLiteralExpression(expr)) return { objects: [expr], opaque: false };
  if (ts.isPropertyAccessExpression(expr)) {
    const entry = sheetEntry(expr);
    return entry ? { objects: [entry], opaque: false } : { objects: [], opaque: true };
  }
  // `cond && styles.x`: only the guarded entry can add size.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return styleObjects(expr.right);
  }
  return { objects: [], opaque: true };
}

function resolveStyle(objects: ts.ObjectLiteralExpression[]): Style {
  const style: Style = {};
  for (const object of objects) {
    for (const prop of object.properties) {
      if (ts.isPropertyAssignment(prop)) {
        style[prop.name.getText()] = evaluate(prop.initializer);
      }
    }
  }
  return style;
}

type SlopResult = { sides: Sides } | { unreadable: true } | { oversized: number };

/** The slop on each side, or why it cannot count. */
function hitSlopOf(expr: ts.Expression | undefined, width: number, height: number): SlopResult {
  const none: Sides = { top: 0, bottom: 0, left: 0, right: 0 };
  if (!expr) return { sides: none };
  const target = ts.isIdentifier(expr) ? lookup(expr.text, expr) : expr;
  if (!target) return { unreadable: true };
  if (ts.isNumericLiteral(target)) {
    const n = Number(target.text);
    return { sides: { top: n, bottom: n, left: n, right: n } };
  }
  if (ts.isObjectLiteralExpression(target)) {
    const sides = { ...none };
    for (const prop of target.properties) {
      if (!ts.isPropertyAssignment(prop)) return { unreadable: true };
      const value = evaluate(prop.initializer);
      const key = prop.name.getText() as keyof Sides;
      if (value === undefined || !(key in sides)) return { unreadable: true };
      sides[key] = value;
    }
    return { sides };
  }
  if (ts.isCallExpression(target) && target.expression.getText() === 'touchTargetHitSlop') {
    const [w, h] = target.arguments.map((a) => evaluate(a));
    if (w === undefined || (target.arguments.length > 1 && h === undefined)) return { unreadable: true };
    // The helper pads the size it is told; trust it only when told no more than the real size.
    const told = { w, h: h ?? w };
    if (told.w > width) return { oversized: told.w };
    if (told.h > height) return { oversized: told.h };
    const v = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - told.h) / 2));
    const hz = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - told.w) / 2));
    return { sides: { top: v, bottom: v, left: hz, right: hz } };
  }
  return { unreadable: true };
}

function openingOf(child: ts.JsxChild): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxSelfClosingElement(child)) return child;
  if (ts.isJsxElement(child)) return child.openingElement;
  return undefined;
}

/** The icon a pressable is sized around: its first child, or the only icon in a text-free body. */
function sizingIcon(node: ts.JsxElement): ts.JsxOpeningLikeElement | undefined {
  const children = node.children.filter(
    (c) => !(ts.isJsxText(c) && c.text.trim() === '') && !(ts.isJsxExpression(c) && !c.expression)
  );
  const first = children[0] && openingOf(children[0]);
  if (first && ICONS.has(first.tagName.getText())) return first;

  // Otherwise only a body of icons in plain views: text, or a component such
  // as an Avatar, sizes the button some other way.
  let icon: ts.JsxOpeningLikeElement | undefined;
  let sizedOtherwise = false;
  const scan = (n: ts.Node): void => {
    if (ts.isJsxText(n) && n.text.trim() !== '') sizedOtherwise = true;
    const opening = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxOpeningElement(n) ? n : undefined;
    if (opening) {
      const name = opening.tagName.getText();
      if (ICONS.has(name)) icon = icon ?? opening;
      else if (TEXT.has(name) || !NEUTRAL.has(name)) sizedOtherwise = true;
    }
    ts.forEachChild(n, scan);
  };
  node.children.forEach(scan);
  return icon && !sizedOtherwise ? icon : undefined;
}

export function findSmallIconButtons(fileName: string, text: string): SizeFinding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: SizeFinding[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const visit = (node: ts.Node): void => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (PRESSABLES.has(opening.tagName.getText())) {
        const { objects, opaque } = styleObjects(initializerExpression(attribute(opening, 'style')));

        for (const object of objects) {
          for (const prop of object.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              SIZE_KEYS.has(prop.name.getText()) &&
              ts.isNumericLiteral(prop.initializer) &&
              prop.initializer.text === String(MIN_TOUCH_TARGET)
            ) {
              findings.push({
                file: fileName,
                line: lineOf(prop),
                problem: `literal ${MIN_TOUCH_TARGET} for ${prop.name.getText()}; use MIN_TOUCH_TARGET`,
              });
            }
          }
        }

        const icon = ts.isJsxElement(node) ? sizingIcon(node) : undefined;
        if (icon && attribute(opening, 'accessible')?.initializer?.getText() !== '{false}') {
          const line = lineOf(node);
          const iconSize = evaluate(initializerExpression(attribute(icon, 'size')));
          if (iconSize === undefined || opaque) {
            findings.push({ file: fileName, line, problem: 'icon button size unresolved' });
          } else {
            const s = resolveStyle(objects);
            const pad = (side: number | undefined, axis: number | undefined): number => side ?? axis ?? s.padding ?? 0;
            const drawnWidth = iconSize + pad(s.paddingLeft, s.paddingHorizontal) + pad(s.paddingRight, s.paddingHorizontal);
            const drawnHeight = iconSize + pad(s.paddingTop, s.paddingVertical) + pad(s.paddingBottom, s.paddingVertical);
            const width = Math.max(drawnWidth, s.width ?? 0, s.minWidth ?? 0);
            const height = Math.max(drawnHeight, s.height ?? 0, s.minHeight ?? 0);
            const slop = hitSlopOf(initializerExpression(attribute(opening, 'hitSlop')), width, height);
            if ('unreadable' in slop) {
              findings.push({ file: fileName, line, problem: 'hitSlop unresolved' });
            } else if ('oversized' in slop) {
              findings.push({
                file: fileName,
                line,
                problem: `hitSlop argument ${slop.oversized} exceeds the button's ${Math.min(width, height)}pt size; pass the real size`,
              });
            } else {
              const reachW = width + slop.sides.left + slop.sides.right;
              const reachH = height + slop.sides.top + slop.sides.bottom;
              if (reachW < MIN_TOUCH_TARGET || reachH < MIN_TOUCH_TARGET) {
                findings.push({ file: fileName, line, problem: `icon button is ${reachW}x${reachH}` });
              }
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
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);

    const findings = files.flatMap((file) =>
      findSmallIconButtons(path.relative(MOBILE_ROOT, file), fs.readFileSync(file, 'utf8'))
    );

    expect(findings.map((f) => `${f.file}:${f.line} ${f.problem}`)).toEqual([]);
  });

  describe('the scanner', () => {
    const sheet = (entry: string) =>
      `const styles = StyleSheet.create({ button: ${entry}, header: { padding: spacing.sm } });`;
    const problems = (code: string) => findSmallIconButtons('sample.tsx', code).map((f) => `${f.line} ${f.problem}`);

    it('reports a 22pt icon with spacing.xs padding: the team hero edit/delete defect', () => {
      expect(
        problems(`
        const A = () => (
          <TouchableOpacity style={styles.button} onPress={edit}>
            <Ionicons name="create-outline" size={22} />
          </TouchableOpacity>
        );
        ${sheet('{ padding: spacing.xs }')}
        `)
      ).toEqual(['3 icon button is 30x30']);
    });

    it('accepts a hitSlop, a 44pt minimum and enough padding', () => {
      const button = (props: string, size = 24) =>
        `<TouchableOpacity ${props} onPress={go}><Ionicons name="x" size={${size}} /></TouchableOpacity>`;
      expect(
        problems(`
        const ICON = 22;
        const A = () => (
          <View>
            ${button('style={styles.button} hitSlop={touchTargetHitSlop(30)}', 22)}
            ${button('style={styles.button} hitSlop={touchTargetHitSlop(ICON + 2 * spacing.xs)}', 22)}
            ${button('style={styles.button} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}')}
            ${button('style={styles.header} hitSlop={HEADER_ICON_HIT_SLOP}')}
            ${button('style={[styles.button, { minWidth: MIN_TOUCH_TARGET, minHeight: MIN_TOUCH_TARGET }]}')}
            ${button('style={{ padding: spacing.sm + 2 }}')}
          </View>
        );
        ${sheet('{ padding: spacing.xs }')}
        `)
      ).toEqual([]);
    });

    it('resolves each component\'s own constant when two declare the same name', () => {
      // Small's ICON is 22 (30pt drawn, slop for 30: fine); Large's ICON is 40,
      // so the slop it asks for is bigger than Small's real button. A flat,
      // scope-blind map would let one ICON override the other.
      expect(
        problems(`
        const Small = () => {
          const ICON = 22;
          return (
            <TouchableOpacity style={styles.button} hitSlop={touchTargetHitSlop(ICON + 2 * spacing.xs)} onPress={go}>
              <Ionicons name="x" size={ICON} />
            </TouchableOpacity>
          );
        };
        const Large = () => {
          const ICON = 40;
          return (
            <TouchableOpacity style={styles.button} onPress={go}>
              <Ionicons name="x" size={ICON} />
            </TouchableOpacity>
          );
        };
        const Wrong = () => {
          const ICON = 22;
          const SLOP = 40;
          return (
            <TouchableOpacity style={styles.button} hitSlop={touchTargetHitSlop(SLOP)} onPress={go}>
              <Ionicons name="x" size={ICON} />
            </TouchableOpacity>
          );
        };
        ${sheet('{ padding: spacing.xs }')}
        `)
      ).toEqual(["22 hitSlop argument 40 exceeds the button's 30pt size; pass the real size"]);
    });

    it('names a hitSlop written for a bigger button than the one it sits on', () => {
      expect(
        problems(`
        const A = () => (
          <View>
            <TouchableOpacity style={styles.button} hitSlop={touchTargetHitSlop(40)} onPress={go}>
              <Ionicons name="x" size={22} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} hitSlop={HEADER_ICON_HIT_SLOP} onPress={go}>
              <Ionicons name="x" size={22} />
            </TouchableOpacity>
          </View>
        );
        ${sheet('{ padding: spacing.xs }')}
        `)
      ).toEqual([
        "4 hitSlop argument 40 exceeds the button's 30pt size; pass the real size",
        "7 hitSlop argument 40 exceeds the button's 30pt size; pass the real size",
      ]);
    });

    it('checks a button whose first child is an icon, or that has an icon and no text', () => {
      expect(
        problems(`
        const A = () => (
          <View>
            <TouchableOpacity style={styles.button} onPress={bell}>
              <Ionicons name="notifications" size={22} />
              <View style={styles.badge}><ThemedText>3</ThemedText></View>
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={go}>
              <View><Ionicons name="x" size={22} /></View>
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={row}>
              <ThemedText>Row</ThemedText>
              <Ionicons name="chevron-forward" size={20} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={pick}>
              <Avatar size="large" />
              <View><Ionicons name="camera" size={14} /></View>
            </TouchableOpacity>
          </View>
        );
        ${sheet('{ padding: spacing.xs }')}
        `)
      ).toEqual(['4 icon button is 30x30', '8 icon button is 30x30']);
    });

    it('reports a literal 44 in a pressable style', () => {
      expect(
        problems(`
        const A = () => <Pressable style={styles.button} onPress={go}><Text>Go</Text></Pressable>;
        ${sheet('{ minHeight: 44, minWidth: MIN_TOUCH_TARGET }')}
        `)
      ).toEqual(['3 literal 44 for minHeight; use MIN_TOUCH_TARGET']);
    });

    it('reports a size it cannot work out', () => {
      expect(
        problems(
          `const A = () => <Pressable style={makeStyle()} onPress={go}><Ionicons name="x" size={24} /></Pressable>;`
        )
      ).toEqual(['1 icon button size unresolved']);
    });
  });
});
