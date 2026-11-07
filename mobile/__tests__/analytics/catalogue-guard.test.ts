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
 *       a reason;
 *   (d) no screen or component writes through `apiClient.post/patch/put/delete`
 *       directly (which (c) cannot see), unless the call is allow-listed below
 *       with a reason (#967).
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
const EMITTER_DIRS = ['app', 'components', 'hooks', 'store', 'services', 'utils'];
const HOOKS_DIR = path.join(MOBILE_ROOT, 'hooks');
const DIRECT_WRITE_DIRS = ['app', 'components'];

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

/**
 * Direct `apiClient` writes in `app/` and `components/`, keyed `<file> <method>`,
 * and why each one is accounted for. Every other write belongs in a mutation
 * hook, where (c) checks it fires an event.
 */
const DIRECT_WRITES_ALLOWED: Record<string, string> = {
  'app/onboarding/role.tsx patch':
    '`PATCH /auth/me/role` fires `onboarding_step_completed` from the screen: the onboarding steps have no hook (analytics.md, "Rules").',
  'app/login.tsx post':
    '`POST /auth/dev-login`, development only: a dev session is not an analytics datum (#790), so it fires nothing on purpose.',
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

interface DirectWriteFinding {
  file: string;
  line: number;
  method: string;
}

const WRITE_METHODS = new Set(['post', 'patch', 'put', 'delete']);

/** `apiClient.post/patch/put/delete(...)` calls in a source text. */
export function findDirectWrites(fileName: string, text: string): DirectWriteFinding[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const findings: DirectWriteFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'apiClient' &&
      WRITE_METHODS.has(node.expression.name.text)
    ) {
      findings.push({
        file: fileName,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        method: node.expression.name.text,
      });
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

  it('(d) no screen or component writes through apiClient directly, unless allow-listed with a reason', () => {
    const files = DIRECT_WRITE_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx']));
    expect(files.length).toBeGreaterThan(30);
    const findings = files.flatMap((file) =>
      findDirectWrites(path.relative(MOBILE_ROOT, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8'))
    );
    const unexplained = findings.filter((f) => !DIRECT_WRITES_ALLOWED[`${f.file} ${f.method}`]);
    expect(
      unexplained.map((f) => `${f.file}:${f.line} apiClient.${f.method} outside a hook: move it into a mutation hook that fires an event, or allow-list it with a reason`)
    ).toEqual([]);

    // The allow-list must not outlive the calls it names.
    const seen = new Set(findings.map((f) => `${f.file} ${f.method}`));
    const stale = Object.keys(DIRECT_WRITES_ALLOWED).filter((key) => !seen.has(key));
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

    it('finds direct apiClient writes and ignores reads, other clients and hooks', () => {
      const text = `
        export default function Screen() {
          const save = async () => {
            await apiClient.get('/teams');
            await apiClient.post('/teams', {});
            await apiClient.delete('/teams/1');
            await otherClient.post('/x', {});
            mutation.mutate({});
          };
          return <Button onPress={() => apiClient.patch('/auth/me', {})} />;
        }
      `;
      expect(findDirectWrites('app/screen.tsx', text)).toEqual([
        { file: 'app/screen.tsx', line: 5, method: 'post' },
        { file: 'app/screen.tsx', line: 6, method: 'delete' },
        { file: 'app/screen.tsx', line: 10, method: 'patch' },
      ]);
    });
  });
});
