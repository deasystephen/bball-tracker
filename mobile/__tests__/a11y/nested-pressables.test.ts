/**
 * Guard: no pressable inside another pressable (#583).
 *
 * On iOS an accessible element hides everything inside it from the
 * accessibility tree. A button nested in a pressable row can be tapped by a
 * sighted user, but VoiceOver and Maestro see only the row. On Profile → My
 * kids that hid the ⋯ menu, the only way for a guardian to delete a child's
 * record.
 *
 * Screen tests do not catch it: `getByLabelText` finds the nested button. So
 * this reads the source. It looks inside one file at a time; a pressable that
 * a component renders around `children` it is given is out of its reach.
 *
 * Allowed: an outer pressable that opts out with `accessible={false}`
 * (`ActionMenu`'s sheet wrapper does, to claim taps without grouping its
 * items).
 *
 * To fix a finding, make the two pressables siblings inside a plain `View`.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { MOBILE_ROOT, sourceFiles } from '../helpers/source-files';

const SCANNED_DIRS = ['app', 'components'];

/**
 * Components that always render a pressable: the React Native primitives,
 * `Button`, and the app's leaf components whose root is a `TouchableOpacity`
 * (#694).
 */
const ALWAYS_PRESSABLE = new Set([
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'Pressable',
  'Button',
  'AvatarPicker',
  'PrintButton',
  'SortPills',
  'RelationshipChips',
]);
/** Wrappers that render a `TouchableOpacity` only when given `onPress`: `ListItem` and `Card`. */
const PRESSABLE_WITH_ON_PRESS = new Set(['ListItem', 'Card']);

interface Finding {
  file: string;
  line: number;
  inner: string;
  outer: string;
  outerLine: number;
}

interface Outer {
  name: string;
  line: number;
  optsOut: boolean;
}

function attributesOf(node: ts.JsxElement | ts.JsxSelfClosingElement): Map<string, string> {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const result = new Map<string, string>();
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxAttribute(attribute)) {
      result.set(attribute.name.getText(), attribute.initializer?.getText() ?? 'true');
    }
  }
  return result;
}

export function findNestedPressables(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const findings: Finding[] = [];

  const visit = (node: ts.Node, outer: Outer | null): void => {
    let next = outer;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const name = opening.tagName.getText();
      const attributes = attributesOf(node);
      const pressable =
        ALWAYS_PRESSABLE.has(name) || (PRESSABLE_WITH_ON_PRESS.has(name) && attributes.has('onPress'));
      if (pressable) {
        if (outer && !outer.optsOut) {
          findings.push({
            file: fileName,
            line: lineOf(node),
            inner: name,
            outer: outer.name,
            outerLine: outer.line,
          });
        }
        next = {
          name,
          line: lineOf(node),
          optsOut: attributes.get('accessible') === '{false}',
        };
      }
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };

  visit(source, null);
  return findings;
}

describe('nested pressables', () => {
  it('finds none in the app', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.tsx']));
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);

    const findings = files.flatMap((file) =>
      findNestedPressables(path.relative(MOBILE_ROOT, file), fs.readFileSync(file, 'utf8'))
    );

    expect(
      findings.map(
        (f) => `${f.file}:${f.line} ${f.inner} is inside the ${f.outer} that starts at line ${f.outerLine}`
      )
    ).toEqual([]);
  });

  describe('the scanner', () => {
    it('reports a button nested in a pressable row: the My kids defect', () => {
      const findings = findNestedPressables(
        'sample.tsx',
        `
        const Row = () => (
          <TouchableOpacity accessibilityLabel="LeBron James, Mother" onPress={open}>
            <Text>LeBron James</Text>
            <TouchableOpacity accessibilityLabel="More options for LeBron James" onPress={menu}>
              <Icon />
            </TouchableOpacity>
          </TouchableOpacity>
        );
        `
      );

      expect(findings).toEqual([
        { file: 'sample.tsx', line: 5, inner: 'TouchableOpacity', outer: 'TouchableOpacity', outerLine: 3 },
      ]);
    });

    it('reports a nested pressable that has no label, and one nested several levels down', () => {
      const findings = findNestedPressables(
        'sample.tsx',
        `
        const Row = () => (
          <Pressable onPress={open}>
            <View>
              <View>
                <Button title="Clear" onPress={clear} />
              </View>
            </View>
          </Pressable>
        );
        `
      );

      expect(findings.map((f) => `${f.inner} in ${f.outer}`)).toEqual(['Button in Pressable']);
    });

    it('accepts siblings inside a plain View', () => {
      const findings = findNestedPressables(
        'sample.tsx',
        `
        const Row = () => (
          <View>
            <TouchableOpacity onPress={open}><Text>LeBron James</Text></TouchableOpacity>
            <TouchableOpacity onPress={menu}><Icon /></TouchableOpacity>
          </View>
        );
        `
      );

      expect(findings).toEqual([]);
    });

    it('accepts an outer pressable that opts out with accessible={false}', () => {
      const findings = findNestedPressables(
        'sample.tsx',
        `
        const Sheet = () => (
          <Pressable accessible={false} onPress={() => undefined}>
            <TouchableOpacity onPress={close}><Text>Close</Text></TouchableOpacity>
          </Pressable>
        );
        `
      );

      expect(findings).toEqual([]);
    });

    it('treats ListItem as a pressable only when it is given onPress', () => {
      const withAction = `<TouchableOpacity onPress={remove}><Icon /></TouchableOpacity>`;
      const plain = findNestedPressables(
        'sample.tsx',
        `const A = () => <ListItem title="Row" rightElement={${withAction}} />;`
      );
      const pressable = findNestedPressables(
        'sample.tsx',
        `const B = () => <ListItem title="Row" onPress={open} rightElement={${withAction}} />;`
      );

      expect(plain).toEqual([]);
      expect(pressable.map((f) => `${f.inner} in ${f.outer}`)).toEqual(['TouchableOpacity in ListItem']);
    });

    it('treats Card as a pressable only when it is given onPress', () => {
      const pressable = findNestedPressables(
        'sample.tsx',
        `const A = () => <Card onPress={open}><Button title="Clear" onPress={clear} /></Card>;`
      );
      const plain = findNestedPressables(
        'sample.tsx',
        `const B = () => <Card><Button title="Clear" onPress={clear} /></Card>;`
      );

      expect(pressable.map((f) => `${f.inner} in ${f.outer}`)).toEqual(['Button in Card']);
      expect(plain).toEqual([]);
    });

    it('counts the leaf components that always render a pressable', () => {
      const findings = findNestedPressables(
        'sample.tsx',
        `const A = () => (
          <TouchableOpacity onPress={open}>
            <PrintButton title="Print" />
          </TouchableOpacity>
        );`
      );

      expect(findings.map((f) => `${f.inner} in ${f.outer}`)).toEqual(['PrintButton in TouchableOpacity']);
    });
  });
});
