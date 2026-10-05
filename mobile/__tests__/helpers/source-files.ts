/**
 * Shared plumbing for the source-scanning guard tests: walk a directory for
 * source files and report the lines that match a pattern. Not a test file
 * (Jest only collects `*.test.ts(x)`).
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/** The `mobile/` package root. */
export const MOBILE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Absolute paths of every file under `dir` (recursively) whose name ends in
 * one of `extensions`. Throws when `dir` does not exist, so a guard never
 * scans nothing without noticing.
 */
export function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, extensions);
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

/** Every line of `text` matching `pattern`, as `<fileName>:<line> <trimmed text>`. */
export function scanLines(fileName: string, text: string, pattern: RegExp): string[] {
  return text
    .split('\n')
    .flatMap((line, index) => (pattern.test(line) ? [`${fileName}:${index + 1} ${line.trim()}`] : []));
}

/** The text of a file under `mobile/`, by its path relative to the package root. */
export function readSource(relative: string): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, relative), 'utf8');
}

/** Parses `text` as TSX, with parent pointers set (so `getText()` works). */
export function parseTsx(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The 1-based line a node starts on. */
export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/** A JSX element with children, or a self-closing one. */
export type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

/** The tag that carries a JSX element's name and attributes. */
export function openingOf(node: JsxNode): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

/** The tag name as written (`Animated.Text`, `ThemedText`). */
export function tagNameOf(node: JsxNode): string {
  return openingOf(node).tagName.getText();
}

/**
 * The value a JSX attribute holds, as far as the source states it:
 * - `true`: the bare attribute (`<X heading />`)
 * - `literal`: a string, number, boolean or `null`, whether quoted or braced
 *   (`role="heading"`, `role={'heading'}`, `heading={false}`)
 * - `expression`: anything else, whose value only the runtime knows
 */
export type JsxAttributeValue =
  | { kind: 'true' }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'expression'; text: string };

function literalOf(expression: ts.Expression): JsxAttributeValue {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner)) inner = inner.expression;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return { kind: 'literal', value: inner.text };
  }
  if (ts.isNumericLiteral(inner)) return { kind: 'literal', value: Number(inner.text) };
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
  if (inner.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null };
  return { kind: 'expression', text: expression.getText() };
}

/** The value one JSX attribute holds. */
export function jsxAttributeValue(attribute: ts.JsxAttribute): JsxAttributeValue {
  const initializer = attribute.initializer;
  if (!initializer) return { kind: 'true' };
  if (ts.isStringLiteral(initializer)) return { kind: 'literal', value: initializer.text };
  if (ts.isJsxExpression(initializer) && initializer.expression) return literalOf(initializer.expression);
  return { kind: 'expression', text: initializer.getText() };
}

/** Every named attribute on a JSX element (spreads are skipped), by name. */
export function jsxAttributes(node: JsxNode): Map<string, JsxAttributeValue> {
  const result = new Map<string, JsxAttributeValue>();
  for (const attribute of openingOf(node).attributes.properties) {
    if (ts.isJsxAttribute(attribute)) result.set(attribute.name.getText(), jsxAttributeValue(attribute));
  }
  return result;
}

/**
 * The expression a named attribute holds (`{styles.button}` gives
 * `styles.button`, `"Go back"` gives the string literal), for a scanner that
 * evaluates it itself; `undefined` when the attribute is absent or bare.
 */
export function jsxAttributeExpression(node: JsxNode, name: string): ts.Expression | undefined {
  for (const attribute of openingOf(node).attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== name) continue;
    const initializer = attribute.initializer;
    if (!initializer) return undefined;
    return ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  }
  return undefined;
}

/** A literal attribute value, or `undefined` when the attribute is absent, bare or an expression. */
export function literalAttribute(
  attributes: Map<string, JsxAttributeValue>,
  name: string
): string | number | boolean | null | undefined {
  const value = attributes.get(name);
  return value?.kind === 'literal' ? value.value : undefined;
}

/**
 * Walks every JSX element (with children or self-closing) under `root`, in
 * source order. `visit` returns the state its descendants see, so a scanner
 * can carry context down (the enclosing pressable, the enclosing tab item).
 */
export function walkJsx<S>(root: ts.Node, state: S, visit: (node: JsxNode, state: S) => S): void {
  const step = (node: ts.Node, current: S): void => {
    let next = current;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) next = visit(node, current);
    ts.forEachChild(node, (child) => step(child, next));
  };
  step(root, state);
}
