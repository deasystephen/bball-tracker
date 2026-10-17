/**
 * Guard: every export of `shared/types/index.ts` has an importer in mobile
 * app source (#771).
 *
 * The file once held a dozen exports nothing imported (`League`, `Team`,
 * `Entitlements`, …), several describing a schema that no longer exists, and
 * its header invited new code to use them. Only `mobile/` imports the file, so
 * an export with no importer under mobile app source (tests excluded: a type
 * only a test uses is still dead) is dead and fails here. Delete the export,
 * or import it where the app needs it.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { MOBILE_ROOT, parseTsx, sourceFiles } from '../helpers/source-files';

const SHARED_TYPES = path.resolve(MOBILE_ROOT, '..', 'shared', 'types', 'index.ts');
/** App source directories, plus the top-level `mobile/*.ts(x)` files (`index.ts`). */
const SCANNED_DIRS = ['app', 'components', 'config', 'hooks', 'i18n', 'services', 'store', 'theme', 'types', 'utils'];
const SHARED_TYPES_SPECIFIER = /(^|\/)shared\/types(\/index)?$/;

function hasExportModifier(statement: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * Names a module exports at top level: declarations with an `export`
 * modifier, `export { X }` / `export type { X }` lists (the exported name),
 * `export default` (as `default`) and `export * from '…'` (as `* from '…'`,
 * which no importer can match, so a re-export always fails the guard and
 * must be written as a named list instead).
 */
export function exportedNames(fileName: string, text: string): string[] {
  const source = parseTsx(fileName, text);
  return source.statements.flatMap((statement): string[] => {
    if (ts.isExportAssignment(statement)) return ['default'];
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (!clause) return [`* from ${statement.moduleSpecifier?.getText() ?? ''}`];
      if (ts.isNamespaceExport(clause)) return [clause.name.text];
      return clause.elements.map((e) => e.name.text);
    }
    if (!hasExportModifier(statement)) return [];
    const isDefault = ts.getModifiers(statement as ts.HasModifiers)?.some(
      (m) => m.kind === ts.SyntaxKind.DefaultKeyword
    );
    if (isDefault) return ['default'];
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((d) => d.name.getText());
    }
    const named = statement as ts.Statement & { name?: ts.Identifier };
    return named.name ? [named.name.text] : [];
  });
}

/** Names a file imports from `shared/types` (the exported name, not a local alias). */
export function namesImportedFromSharedTypes(fileName: string, text: string): string[] {
  // Most files never mention the module; skip parsing them.
  if (!text.includes('shared/types')) return [];
  const source = parseTsx(fileName, text);
  return source.statements.flatMap((statement): string[] => {
    if (!ts.isImportDeclaration(statement)) return [];
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!SHARED_TYPES_SPECIFIER.test(specifier)) return [];
    const clause = statement.importClause;
    const names = clause?.name ? ['default'] : [];
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return names;
    return [...names, ...bindings.elements.map((e) => (e.propertyName ?? e.name).text)];
  });
}

function appSourceFiles(): string[] {
  const topLevel = fs
    .readdirSync(MOBILE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.join(MOBILE_ROOT, entry.name));
  return [
    ...topLevel,
    ...SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx'])),
  ].filter((file) => !/\.test\.tsx?$/.test(file));
}

describe('shared/types exports are all imported by the app', () => {
  it('finds an importer under mobile/ for every export', () => {
    const exportsList = exportedNames(SHARED_TYPES, fs.readFileSync(SHARED_TYPES, 'utf8'));
    // A guard that reads nothing passes for the wrong reason.
    expect(exportsList.length).toBeGreaterThan(0);

    const files = appSourceFiles();
    expect(files.length).toBeGreaterThan(50);
    const imported = new Set(
      files.flatMap((file) => namesImportedFromSharedTypes(file, fs.readFileSync(file, 'utf8')))
    );

    expect(exportsList.filter((name) => !imported.has(name))).toEqual([]);
  });

  describe('the scanner', () => {
    it('lists exported enums, interfaces, types and consts, not local declarations', () => {
      const text = [
        'export enum Role { A = "A" }',
        'export interface User { id: string }',
        'export type Kind = "x" | "y";',
        'export const LIMIT = 1, OTHER = 2;',
        'interface Local { id: string }',
      ].join('\n');
      expect(exportedNames('x.ts', text)).toEqual(['Role', 'User', 'Kind', 'LIMIT', 'OTHER']);
    });

    it.each([
      ['interface A { id: string }\nexport { A };', ['A']],
      ['type B = string;\nexport type { B };', ['B']],
      ['const c = 1;\nexport { c as Renamed };', ['Renamed']],
      ["export * from './other';", ["* from './other'"]],
      ["export * as ns from './other';", ['ns']],
      ['const d = 1;\nexport default d;', ['default']],
      ['export default function f() { return 1; }', ['default']],
    ])('lists the exports of %s', (text, expected) => {
      expect(exportedNames('x.ts', text)).toEqual(expected);
    });

    it.each([
      ["import type { User } from '../../shared/types';", ['User']],
      ["import { UserRole, type User } from '../../../shared/types';", ['UserRole', 'User']],
      ["import { GuardianOfEntry as Entry } from '../../shared/types/index';", ['GuardianOfEntry']],
      ["import type { Team } from '../hooks/useTeams';", []],
      ["import * as shared from '../../shared/types';", []],
      ["import Shared from '../../shared/types';", ['default']],
      ["// mentions shared/types in a comment only", []],
    ])('reads %s', (line, expected) => {
      expect(namesImportedFromSharedTypes('x.ts', line)).toEqual(expected);
    });
  });
});
