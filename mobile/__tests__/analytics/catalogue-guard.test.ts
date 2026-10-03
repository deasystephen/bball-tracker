/**
 * Guard: the Amplitude catalogue, the doc and the code agree (#616).
 *
 * Reads the source, like `a11y/nested-pressables.test.ts`:
 *   (a) every `AnalyticsEvents` entry in `services/analytics.ts` has a row
 *       in `docs/architecture/analytics.md`, and every documented row is an
 *       entry;
 *   (b) every entry is emitted somewhere in `mobile/` source (a catalogued
 *       event nobody sends is dead taxonomy);
 *   (c) every `useMutation(...)` in `hooks/` fires `trackEvent` from its
 *       `onSuccess` or `onSettled`, unless the hook is allow-listed below with
 *       a reason.
 *
 * To fix a finding: add the row to the doc, emit the event from the hook or
 * store that performs the mutation (never from a screen), or explain here
 * why a hook is exempt.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const ANALYTICS_SOURCE = path.join(MOBILE_ROOT, 'services', 'analytics.ts');
const CATALOGUE_DOC = path.resolve(MOBILE_ROOT, '..', 'docs', 'architecture', 'analytics.md');
const EMITTER_DIRS = ['app', 'components', 'hooks', 'store', 'services'];
const HOOKS_DIR = path.join(MOBILE_ROOT, 'hooks');

/**
 * Mutation hooks that fire no event, and why. An entry here is a decision,
 * reviewed in the PR that adds it.
 */
const MUTATIONS_WITHOUT_EVENTS: Record<string, string> = {
  useCreatePlayer:
    'No screen calls it: the unified Add Player (`useAddRosterPlayer`, #418) replaced it. Instrument or remove when a screen uses it.',
  useDeletePlayer:
    'No screen calls it: roster removal is `useRemovePlayerFromTeam`, account deletion is `useDeleteAccount`. Instrument or remove when a screen uses it.',
};

function sourceFiles(dir: string, extensions: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full, extensions);
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

/** `KEY → 'event_name'` from the `AnalyticsEvents` object literal. */
export function cataloguedEvents(text: string): Map<string, string> {
  const source = ts.createSourceFile('analytics.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const events = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'AnalyticsEvents' &&
      node.initializer
    ) {
      let literal: ts.Node = node.initializer;
      while (ts.isAsExpression(literal)) literal = literal.expression;
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
            events.set(property.name.getText(), property.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return events;
}

/**
 * Event names in the first column of the "## Event catalogue" table
 * (`| \`name\` | …`). Only that section: the user-property and glossary
 * tables start their rows with backticked names too.
 */
export function documentedEvents(markdown: string): string[] {
  const names: string[] = [];
  let inCatalogue = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) inCatalogue = line.trim() === '## Event catalogue';
    if (!inCatalogue) continue;
    const match = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/** `AnalyticsEvents.KEY` references in a source text. */
export function emittedKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(/AnalyticsEvents\.([A-Z_]+)/g)) keys.add(match[1]);
  return keys;
}

interface MutationFinding {
  file: string;
  line: number;
  hook: string;
}

/** `useMutation` calls whose `onSuccess` / `onSettled` never call `trackEvent`. */
export function findSilentMutations(fileName: string, text: string): MutationFinding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: MutationFinding[] = [];

  const enclosingHook = (node: ts.Node): string => {
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
      current = current.parent;
    }
    return '<anonymous>';
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useMutation') {
      const options = node.arguments[0];
      let tracked = false;
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          const name = property.name?.getText();
          if ((name === 'onSuccess' || name === 'onSettled') && property.getText().includes('trackEvent(')) {
            tracked = true;
          }
        }
      }
      if (!tracked) {
        findings.push({
          file: fileName,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          hook: enclosingHook(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('analytics catalogue guard', () => {
  const catalogue = cataloguedEvents(fs.readFileSync(ANALYTICS_SOURCE, 'utf8'));
  const documented = documentedEvents(fs.readFileSync(CATALOGUE_DOC, 'utf8'));

  it('reads a catalogue worth guarding', () => {
    expect(catalogue.size).toBeGreaterThan(20);
  });

  it('(a) every catalogued event has a row in docs/architecture/analytics.md, and nothing else does', () => {
    const inCode = [...catalogue.values()].sort();
    const inDoc = [...new Set(documented)].sort();
    expect(inDoc).toEqual(inCode);
    // A name documented twice is two rows for one event.
    expect(documented.length).toBe(inDoc.length);
  });

  it('(b) every catalogued event is emitted from mobile source', () => {
    const files = EMITTER_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx'])).filter(
      (file) => file !== ANALYTICS_SOURCE
    );
    expect(files.length).toBeGreaterThan(50);
    const emitted = new Set<string>();
    for (const file of files) {
      for (const key of emittedKeys(fs.readFileSync(file, 'utf8'))) emitted.add(key);
    }
    const silent = [...catalogue.keys()].filter((key) => !emitted.has(key));
    expect(silent).toEqual([]);
  });

  it('(c) every mutation hook fires a catalogued event, or is allow-listed with a reason', () => {
    const files = sourceFiles(HOOKS_DIR, ['.ts', '.tsx']);
    expect(files.length).toBeGreaterThan(10);
    const findings = files.flatMap((file) =>
      findSilentMutations(path.relative(MOBILE_ROOT, file), fs.readFileSync(file, 'utf8'))
    );
    const unexplained = findings.filter((f) => !MUTATIONS_WITHOUT_EVENTS[f.hook]);
    expect(unexplained.map((f) => `${f.file}:${f.line} ${f.hook} fires no trackEvent in onSuccess/onSettled`)).toEqual([]);

    // The allow-list must not outlive the hooks it names.
    const silentHooks = new Set(findings.map((f) => f.hook));
    const stale = Object.keys(MUTATIONS_WITHOUT_EVENTS).filter((hook) => !silentHooks.has(hook));
    expect(stale).toEqual([]);
  });

  describe('the scanners', () => {
    it('reads the catalogue object literal', () => {
      expect(
        cataloguedEvents(`export const AnalyticsEvents = { A_B: 'a_b', C_D: 'c_d' } as const;`)
      ).toEqual(new Map([['A_B', 'a_b'], ['C_D', 'c_d']]));
    });

    it('reads the first column of the catalogue table only, ignoring prose and other tables', () => {
      expect(
        documentedEvents(
          [
            '## User properties',
            '| `role` | enum |',
            '## Event catalogue',
            '| Event | When |',
            '| --- | --- |',
            '| `team_created` | on create |',
            'Text with `team_deleted` in it.',
            '### Not events',
            '| `game_deleted`| x |',
            '## Properties glossary',
            '| `team_id` | string |',
          ].join('\n')
        )
      ).toEqual(['team_created', 'game_deleted']);
    });

    it('reports a mutation without trackEvent and names its hook', () => {
      const findings = findSilentMutations(
        'hooks/sample.ts',
        `
        export function useThing() {
          return useMutation({
            mutationFn: async () => undefined,
            onSuccess: () => { queryClient.invalidateQueries(); },
          });
        }
        `
      );
      expect(findings).toEqual([{ file: 'hooks/sample.ts', line: 3, hook: 'useThing' }]);
    });

    it('accepts trackEvent in onSuccess or onSettled, and rejects it in mutationFn', () => {
      const ok = `
        export function useA() {
          return useMutation({ mutationFn: async () => undefined, onSuccess: (_, v) => trackEvent(AnalyticsEvents.X, { id: v }) });
        }
        export const useB = () =>
          useMutation({ mutationFn: async () => undefined, onSettled: () => { trackEvent(AnalyticsEvents.Y); } });
      `;
      expect(findSilentMutations('hooks/ok.ts', ok)).toEqual([]);

      const wrongPlace = `
        export function useC() {
          return useMutation({
            mutationFn: async () => { trackEvent(AnalyticsEvents.Z); },
            onSuccess: () => undefined,
          });
        }
      `;
      expect(findSilentMutations('hooks/wrong.ts', wrongPlace).map((f) => f.hook)).toEqual(['useC']);
    });
  });
});
