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
/** Top-level `mobile/` directories that hold no app source. */
const SKIPPED_DIRS = new Set(['node_modules', 'ios', 'android', '__tests__', 'dist', 'web-build', 'coverage']);
const SHARED_TYPES_SPECIFIER = /(^|\/)shared\/types(\/index)?$/;

/** Names a module exports at top level (declarations with an `export` modifier). */
export function exportedNames(fileName: string, text: string): string[] {
  const source = parseTsx(fileName, text);
  return source.statements.flatMap((statement) => {
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return [];
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((d) => d.name.getText());
    }
    const named = statement as ts.Statement & { name?: ts.Identifier };
    return named.name ? [named.name.text] : [];
  });
}

/** Names a file imports from `shared/types` (the exported name, not a local alias). */
export function namesImportedFromSharedTypes(fileName: string, text: string): string[] {
  const source = parseTsx(fileName, text);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) return [];
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!SHARED_TYPES_SPECIFIER.test(specifier)) return [];
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.map((e) => (e.propertyName ?? e.name).text);
  });
}

function appSourceFiles(): string[] {
  return fs
    .readdirSync(MOBILE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name))
    .flatMap((entry) => sourceFiles(path.join(MOBILE_ROOT, entry.name), ['.ts', '.tsx']));
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
      ["import type { User } from '../../shared/types';", ['User']],
      ["import { UserRole, type User } from '../../../shared/types';", ['UserRole', 'User']],
      ["import { GuardianOfEntry as Entry } from '../../shared/types/index';", ['GuardianOfEntry']],
      ["import type { Team } from '../hooks/useTeams';", []],
      ["import * as shared from '../../shared/types';", []],
    ])('reads %s', (line, expected) => {
      expect(namesImportedFromSharedTypes('x.ts', line)).toEqual(expected);
    });
  });
});
