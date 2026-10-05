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

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { MOBILE_ROOT, sourceFiles } from '../helpers/source-files';

const SCANNED_DIRS = ['app', 'components'];

const PRESSABLES = new Set([
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'Pressable',
]);

/** Icon components whose glyph is meaningless to a screen reader. */
const ICONS = new Set(['Ionicons', 'MaterialIcons', 'MaterialCommunityIcons', 'FontAwesome', 'Feather']);

export interface RoleFinding {
  file: string;
  line: number;
  name: string;
  problem: 'no accessibilityRole' | 'icon-only without accessibilityLabel';
}

function attributeNames(opening: ts.JsxOpeningLikeElement): Map<string, string> {
  const result = new Map<string, string>();
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxAttribute(attribute)) {
      result.set(attribute.name.getText(), attribute.initializer?.getText() ?? 'true');
    } else if (ts.isJsxSpreadAttribute(attribute)) {
      result.set('...', attribute.expression.getText());
    }
  }
  return result;
}

/** The JSX children that render something (whitespace-only text and comments dropped). */
function meaningfulChildren(node: ts.JsxElement): ts.JsxChild[] {
  return node.children.filter((child) => {
    if (ts.isJsxText(child)) return child.text.trim() !== '';
    if (ts.isJsxExpression(child)) return child.expression !== undefined;
    return true;
  });
}

function isIconOnly(node: ts.JsxElement): boolean {
  const children = meaningfulChildren(node);
  if (children.length !== 1) return false;
  const only = children[0];
  const opening = ts.isJsxElement(only) ? only.openingElement : ts.isJsxSelfClosingElement(only) ? only : null;
  return opening !== null && ICONS.has(opening.tagName.getText());
}

export function findUnlabelledPressables(fileName: string, text: string): RoleFinding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: RoleFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const name = opening.tagName.getText();
      if (PRESSABLES.has(name)) {
        const attributes = attributeNames(opening);
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const optsOut = attributes.get('accessible') === '{false}';
        if (!optsOut && !attributes.has('accessibilityRole')) {
          findings.push({ file: fileName, line, name, problem: 'no accessibilityRole' });
        }
        if (!optsOut && ts.isJsxElement(node) && isIconOnly(node) && !attributes.has('accessibilityLabel')) {
          findings.push({ file: fileName, line, name, problem: 'icon-only without accessibilityLabel' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

describe('pressable roles and labels', () => {
  it('finds none missing in the app', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.tsx']));
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);

    const findings = files.flatMap((file) =>
      findUnlabelledPressables(path.relative(MOBILE_ROOT, file), fs.readFileSync(file, 'utf8'))
    );

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
