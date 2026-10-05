/**
 * Guard: every hand-rolled pressable says what it is (#655).
 *
 * React Native gives a bare `TouchableOpacity` or `Pressable` no button trait,
 * so VoiceOver reads it as static text with no cue that double-tap does
 * anything. The shared primitives (`Button`, `Card onPress`, `ListItem`,
 * `SortPills`, `ActionMenu`) already set a role; this reads the source of
 * `app/` and `components/` and fails on any `TouchableOpacity`,
 * `TouchableHighlight`, `TouchableWithoutFeedback` or `Pressable` that has
 * neither an `accessibilityRole` nor `accessible={false}`.
 *
 * It also fails on an icon-only pressable (its only child is an icon) with no
 * `accessibilityLabel`: VoiceOver would read the icon font's private-use glyph.
 *
 * No allow-list: fix the code. A pressable that only claims taps (a sheet
 * wrapper) opts out with `accessible={false}`.
 */

import ts from 'typescript';

import {
  type JsxNode,
  jsxAttributes,
  lineOf,
  literalAttribute,
  parseTsx,
  tagNameOf,
  walkJsx,
} from '../helpers/source-files';
import { ICONS, TOUCHABLES, scannedSources } from '../helpers/pressables';

export interface RoleFinding {
  file: string;
  line: number;
  name: string;
  problem: 'no accessibilityRole' | 'icon-only without accessibilityLabel';
}

/** The JSX children that render something (whitespace-only text and comments dropped). */
function meaningfulChildren(node: ts.JsxElement): ts.JsxChild[] {
  return node.children.filter((child) => {
    if (ts.isJsxText(child)) return child.text.trim() !== '';
    if (ts.isJsxExpression(child)) return child.expression !== undefined;
    return true;
  });
}

function isIconOnly(node: JsxNode): boolean {
  if (!ts.isJsxElement(node)) return false;
  const children = meaningfulChildren(node);
  const only = children.length === 1 ? children[0] : undefined;
  return (
    only !== undefined &&
    (ts.isJsxElement(only) || ts.isJsxSelfClosingElement(only)) &&
    ICONS.has(tagNameOf(only))
  );
}

export function findUnlabelledPressables(fileName: string, text: string): RoleFinding[] {
  const source = parseTsx(fileName, text);
  const findings: RoleFinding[] = [];

  walkJsx(source, null, (node) => {
    const name = tagNameOf(node);
    if (!TOUCHABLES.has(name)) return null;
    const attributes = jsxAttributes(node);
    if (literalAttribute(attributes, 'accessible') === false) return null;
    const line = lineOf(source, node);
    if (!attributes.has('accessibilityRole')) {
      findings.push({ file: fileName, line, name, problem: 'no accessibilityRole' });
    }
    if (isIconOnly(node) && !attributes.has('accessibilityLabel')) {
      findings.push({ file: fileName, line, name, problem: 'icon-only without accessibilityLabel' });
    }
    return null;
  });

  return findings;
}

describe('pressable roles and labels', () => {
  it('finds none missing in the app', () => {
    const findings = scannedSources().flatMap(({ file, text }) => findUnlabelledPressables(file, text));

    expect(findings.map((f) => `${f.file}:${f.line} ${f.name}: ${f.problem}`)).toEqual([]);
  });

  describe('the scanner', () => {
    it('reports a pressable with no role: the Home "See All" defect', () => {
      const findings = findUnlabelledPressables(
        'sample.tsx',
        `
        const A = () => (
          <TouchableOpacity onPress={() => router.push('/teams')}>
            <ThemedText>See All</ThemedText>
          </TouchableOpacity>
        );
        `
      );

      expect(findings).toEqual([
        { file: 'sample.tsx', line: 3, name: 'TouchableOpacity', problem: 'no accessibilityRole' },
      ]);
    });

    it('reports an icon-only pressable without a label, even with a role', () => {
      const findings = findUnlabelledPressables(
        'sample.tsx',
        `
        const A = () => (
          <Pressable accessibilityRole="button" onPress={back}>
            <Ionicons name="arrow-back" size={24} />
          </Pressable>
        );
        `
      );

      expect(findings.map((f) => f.problem)).toEqual(['icon-only without accessibilityLabel']);
    });

    it('accepts a labelled icon button and a text button with a role', () => {
      const findings = findUnlabelledPressables(
        'sample.tsx',
        `
        const A = () => (
          <View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={back}>
              <Ionicons name="arrow-back" size={24} />
            </TouchableOpacity>
            <TouchableHighlight accessibilityRole="link" onPress={open}>
              <Text>Privacy</Text>
            </TouchableHighlight>
          </View>
        );
        `
      );

      expect(findings).toEqual([]);
    });

    it('accepts a pressable that opts out with accessible={false}', () => {
      const findings = findUnlabelledPressables(
        'sample.tsx',
        `const Sheet = () => <Pressable accessible={false} onPress={() => undefined}><Ionicons name="x" /></Pressable>;`
      );

      expect(findings).toEqual([]);
    });

    it('does not treat an icon next to text as icon-only', () => {
      const findings = findUnlabelledPressables(
        'sample.tsx',
        `
        const A = () => (
          <TouchableOpacity accessibilityRole="button" onPress={print}>
            <Ionicons name="print" />
            <Text>Print</Text>
          </TouchableOpacity>
        );
        `
      );

      expect(findings).toEqual([]);
    });
  });
});
