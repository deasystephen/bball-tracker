/**
 * The scanner behind `__tests__/i18n/hardcoded-copy.test.ts` (#671): finds
 * user-facing copy written as a literal instead of going through `t()`. Not a
 * test file (Jest only collects `*.test.ts(x)`).
 *
 * "User-facing" is decided by position, never by spelling, so a string used as
 * a value (`status === 'LIVE'`, `router.push('/teams')`, `t('games.title')`) is
 * never reported. A literal is copy when it is:
 * - JSX text (`<ThemedText>Games</ThemedText>`) or a string in a JSX child
 *   expression (`{pending ? 'SAVING…' : label}`);
 * - the value of a copy prop (`title`, `label`, `placeholder`,
 *   `accessibilityLabel`, … in `COPY_NAMES`), whether a JSX attribute, an object
 *   property (`{ label: 'Jersey #' }`, `options={{ title: 'Home' }}`) or a
 *   destructured default (`title = 'Something went wrong'`);
 * - an `Alert.alert` button's `text`;
 * - an argument to a call that shows text (`Alert.alert`, `showToast`,
 *   `useAccessGuard`, an announcement, a `set…Error` setter) or the right-hand
 *   side of an assignment into an `errors` object.
 *
 * Inside those positions only the branches that can reach the screen are read:
 * a conditional's two results, both sides of `||`/`??`/`+`, the right side of
 * `&&`, and a template literal's text. A call (`t(...)`, `formatDate(...)`), an
 * identifier or nested JSX ends the walk. A literal counts only when it holds a
 * letter, so numbers and symbols (`·`, `—`, `%`, `#`) pass.
 *
 * Not read: `return '<literal>'` and `throw new Error('<literal>')`, which are
 * values far more often than copy. A helper that returns copy
 * (`rosterStatusLabel`, `formatInvitationExpiry`) is localized at the source and
 * pinned by its Spanish unit test instead.
 */

import ts from 'typescript';

import { lineOf, parseTsx } from './source-files';

/** Props, object keys and destructured defaults whose value is shown or spoken. */
export const COPY_NAMES: ReadonlySet<string> = new Set([
  'accessibilityHint',
  'accessibilityLabel',
  'actionLabel',
  'backLabel',
  'cancelLabel',
  'confirmLabel',
  'description',
  'emptyMessage',
  'headerTitle',
  'hint',
  'label',
  'labelPrefix',
  'message',
  'placeholder',
  'retryLabel',
  'shortLabel',
  'subtitle',
  'tabBarAccessibilityLabel',
  'tabBarLabel',
  'title',
]);

/**
 * Calls whose arguments are shown or spoken, matched on the callee's last name,
 * with the positions that carry copy (`showToast(message, 'error')`: only the message).
 */
export const COPY_CALLS: ReadonlyMap<string, readonly number[]> = new Map([
  ['alert', [0, 1]],
  ['announce', [0]],
  ['announceForAccessibility', [0]],
  // The fallback message shown when an error carries none of its own.
  ['describeApiError', [1]],
  ['getApiErrorMessage', [1]],
  ['showToast', [0]],
  ['useAccessGuard', [2]],
  ['useQueryErrorState', [1]],
]);

/** A `set…Error` / `set…Errors` state setter: its argument is shown under a field. */
const ERROR_SETTER = /^set\w*Errors?$/;
/** An assignment target inside a validation-errors object (`errors.name = …`, `newErrors[field] = …`). */
const ERRORS_TARGET = /^\w*[eE]rrors(\.|\[)/;

/**
 * Exact literals that are copy in every language: the product name. Keep this
 * tiny and justify each entry; anything else goes through `t()`.
 */
export const ALLOWED_LITERALS: ReadonlySet<string> = new Set(['Hooplings']);

export interface CopyFinding {
  file: string;
  line: number;
  text: string;
}

const HAS_LETTER = /\p{L}/u;
/** A URL (a link placeholder such as `https://chat.whatsapp.com/...`) reads the same in every language. */
const URL_LITERAL = /^https?:\/\/\S+$/;

function isCopy(text: string): boolean {
  const trimmed = text.trim();
  return HAS_LETTER.test(trimmed) && !ALLOWED_LITERALS.has(trimmed) && !URL_LITERAL.test(trimmed);
}

/** The literal nodes an expression can render, following only the branches that reach the screen. */
function renderedLiterals(expression: ts.Expression | undefined): ts.Node[] {
  if (!expression) return [];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return isCopy(expression.text) ? [expression] : [];
  }
  if (ts.isTemplateExpression(expression)) {
    const parts = [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)];
    const own = isCopy(parts.join(' ')) ? [expression] : [];
    return [...own, ...expression.templateSpans.flatMap((span) => renderedLiterals(span.expression))];
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return renderedLiterals(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return [...renderedLiterals(expression.whenTrue), ...renderedLiterals(expression.whenFalse)];
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.PlusToken:
        return [...renderedLiterals(expression.left), ...renderedLiterals(expression.right)];
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return renderedLiterals(expression.right);
      default:
        return [];
    }
  }
  return [];
}

function nameOf(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return name.name.text;
  return undefined;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/**
 * Code that never runs in a release build: the right side of `__DEV__ && …`, and a
 * function whose first statement is `if (!__DEV__) return …`. Developer diagnostics
 * there are not product copy.
 */
function isDevOnly(node: ts.Node): boolean {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    ts.isIdentifier(node.left) &&
    node.left.text === '__DEV__'
  ) {
    return true;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.body && ts.isBlock(node.body)) {
    const first = node.body.statements[0];
    return (
      first !== undefined &&
      ts.isIfStatement(first) &&
      ts.isPrefixUnaryExpression(first.expression) &&
      first.expression.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(first.expression.operand) &&
      first.expression.operand.text === '__DEV__'
    );
  }
  return false;
}

/** The `text` of each button in an `Alert.alert` buttons array. */
function alertButtonLiterals(buttons: ts.Expression | undefined): ts.Node[] {
  if (!buttons || !ts.isArrayLiteralExpression(buttons)) return [];
  return buttons.elements.flatMap((button) =>
    ts.isObjectLiteralExpression(button)
      ? button.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) && nameOf(property.name) === 'text'
            ? renderedLiterals(property.initializer)
            : []
        )
      : []
  );
}

/** Every hard-coded piece of copy in one source file (`.ts` is parsed as TypeScript, anything else as TSX). */
export function findHardcodedCopy(fileName: string, text: string): CopyFinding[] {
  const source = fileName.endsWith('.ts')
    ? ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    : parseTsx(fileName, text);
  const nodes: ts.Node[] = [];

  const visit = (node: ts.Node): void => {
    if (isDevOnly(node)) return;
    if (ts.isJsxText(node)) {
      // HTML entities (`&ldquo;`, `&apos;`) are punctuation, not words.
      if (isCopy(node.text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, ' '))) nodes.push(node);
    } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      nodes.push(...renderedLiterals(node.expression));
    } else if (ts.isJsxAttribute(node)) {
      const name = nameOf(node.name);
      if (name && COPY_NAMES.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          nodes.push(...renderedLiterals(node.initializer));
        } else if (ts.isJsxExpression(node.initializer)) {
          nodes.push(...renderedLiterals(node.initializer.expression));
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.name);
      if (name && COPY_NAMES.has(name)) nodes.push(...renderedLiterals(node.initializer));
    } else if (ts.isBindingElement(node) && node.initializer) {
      const name = nameOf(node.propertyName ?? node.name);
      if (name && COPY_NAMES.has(name)) nodes.push(...renderedLiterals(node.initializer));
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const positions = name ? (COPY_CALLS.get(name) ?? (ERROR_SETTER.test(name) ? [0] : [])) : [];
      for (const position of positions) nodes.push(...renderedLiterals(node.arguments[position]));
      if (name === 'alert') nodes.push(...alertButtonLiterals(node.arguments[2]));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ERRORS_TARGET.test(node.left.getText(source))
    ) {
      nodes.push(...renderedLiterals(node.right));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return nodes.map((node) => ({
    file: fileName,
    line: lineOf(source, node),
    text: node.getText(source).trim().replace(/\s+/g, ' '),
  }));
}
