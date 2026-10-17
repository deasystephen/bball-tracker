/**
 * Guard for #813: every user embedded in a payload carries `deletedAt`.
 *
 * Mobile renders names through `displayName`, which reads `deletedAt`; a
 * payload without it shows the stored English "Deleted user" untranslated
 * (CLAUDE.md: read tombstone state from `deletedAt`, never from the name).
 * #642 fixed the selects one by one and missed six; this suite fails on any
 * `select` with `name: true` on a `User` relation key in `src/` that neither
 * selects `deletedAt: true` nor spreads a `USER_SUMMARY` constant from
 * `src/utils/user-select.ts`.
 *
 * The relation keys come from `prisma/schema.prisma` (every field typed
 * `User`, `User?` or `User[]`), so a new relation is covered without editing
 * this file. Both forms are checked: an inline `key: { select: { … } }` and
 * `key: { select: IDENT }` where `IDENT` is a `const IDENT = { … }` declared
 * in the same file. A constant imported from another file is checked where
 * it is declared, if it is used inline there; the shared constants are pinned
 * below.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { sourceFiles, stripComments } from '../support/source-scan';
import { USER_SUMMARY_SELECT, USER_SUMMARY_WITH_EMAIL_SELECT } from '../../src/utils/user-select';

const BACKEND = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND, 'src');
const GENERATED = path.join(SRC, 'generated');
const SCHEMA = path.join(BACKEND, 'prisma/schema.prisma');

/** Every relation field typed `User`, `User?` or `User[]` in the Prisma schema. */
export function userRelationKeys(schema: string): string[] {
  const keys = new Set<string>();
  for (const match of schema.matchAll(/^\s+(\w+)\s+User(?:\?|\[\])?(?=\s|$)/gm)) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

const USER_RELATION_KEYS = userRelationKeys(readFileSync(SCHEMA, 'utf8'));

/** The text between the `{` at `open` and its matching `}`. */
function blockBody(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

/** Drops nested `{ … }` blocks so only the select's own keys remain. */
function topLevel(body: string): string {
  let out = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth += 1;
    if (depth === 0) out += ch;
    if (ch === '}') depth -= 1;
  }
  return out;
}

/** Whether a select's own keys expose a name without the tombstone signal. */
function lacksTombstone(keys: string): boolean {
  if (!/\bname\s*:\s*true\b/.test(keys)) return false;
  return !/\bdeletedAt\s*:\s*true\b/.test(keys) && !/\.\.\.\s*USER_SUMMARY\w*/.test(keys);
}

/**
 * User selects (inline, or a same-file constant by name) that expose a name
 * without the tombstone signal. `relationKeys` defaults to the schema's.
 */
export function findUserSelectsWithoutDeletedAt(
  source: string,
  relationKeys: string[] = USER_RELATION_KEYS
): string[] {
  const code = stripComments(source);
  const keyGroup = relationKeys.join('|');
  const offenders: string[] = [];

  const inline = new RegExp(`\\b(?:${keyGroup})\\s*:\\s*\\{\\s*select\\s*:\\s*\\{`, 'g');
  for (const match of code.matchAll(inline)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const keys = topLevel(blockBody(code, open));
    if (lacksTombstone(keys)) offenders.push(`${match[0]}${keys.replace(/\s+/g, ' ')}}`);
  }

  const byName = new RegExp(`\\b(?:${keyGroup})\\s*:\\s*\\{\\s*select\\s*:\\s*([A-Z_][A-Z0-9_]*)\\b`, 'g');
  for (const match of code.matchAll(byName)) {
    const constant = match[1];
    const declaration = new RegExp(`\\bconst\\s+${constant}\\s*(?::[^=]+)?=\\s*\\{`).exec(code);
    if (!declaration) continue;
    const open = declaration.index + declaration[0].length - 1;
    const keys = topLevel(blockBody(code, open));
    if (lacksTombstone(keys)) offenders.push(`${match[0]} = {${keys.replace(/\s+/g, ' ')}}`);
  }
  return offenders;
}

describe('every user select carries deletedAt (#813)', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = sourceFiles(SRC).filter((file) => !file.startsWith(GENERATED));
  });

  it('scans the backend source', () => {
    // A guard that reads nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(SRC, 'services/season-service.ts'));
    expect(files).toContain(path.join(SRC, 'websocket/game-events.ts'));
  });

  it('reads the relation keys from the Prisma schema', () => {
    expect(USER_RELATION_KEYS).toEqual(
      expect.arrayContaining(['author', 'child', 'invitedBy', 'managedBy', 'parent', 'player', 'user'])
    );
  });

  it('finds no inline user select with a name and without deletedAt', () => {
    const offenders = files.flatMap((file) =>
      findUserSelectsWithoutDeletedAt(readFileSync(file, 'utf8')).map(
        (match) => `${path.relative(BACKEND, file)}: ${match}`
      )
    );

    expect(offenders).toEqual([]);
  });

  it('the shared constants carry the tombstone signal, and only one carries email', () => {
    expect(USER_SUMMARY_SELECT).toEqual({ id: true, name: true, isManaged: true, deletedAt: true });
    expect(USER_SUMMARY_WITH_EMAIL_SELECT).toEqual({ ...USER_SUMMARY_SELECT, email: true });
  });

  it('no service declares its own USER_SUMMARY constant', () => {
    const declarations = files
      .filter((file) => !file.endsWith(path.join('utils', 'user-select.ts')))
      .filter((file) => /\bconst\s+USER_SUMMARY\w*\s*=/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(BACKEND, file));
    expect(declarations).toEqual([]);
  });
});

describe('the guard pattern', () => {
  it('derives relation keys from schema fields typed User', () => {
    const schema = [
      'model Guardian {',
      '  parent   User   @relation("GuardianParent", fields: [parentId], references: [id])',
      '  managedBy User? @relation("ManagedPlayers")',
      '  managedPlayers User[] @relation("ManagedPlayers")',
      '  team     Team   @relation(fields: [teamId], references: [id])',
      '  userId   String',
      '  Username String',
      '}',
    ].join('\n');
    expect(userRelationKeys(schema)).toEqual(['managedBy', 'managedPlayers', 'parent']);
  });

  it.each([
    ['player: { select: { id: true, name: true } }'],
    ['user: {\n  select: {\n    id: true,\n    name: true,\n    email: true,\n  },\n}'],
    ['author: { select: { id: true, name: true, profilePictureUrl: true } }'],
    ['invitedBy: { select: { name: true } }'],
    ['staff: { include: { user: { select: { id: true, name: true } }, role: true } }'],
    // A nested relation's deletedAt is not the user's own.
    ['player: { select: { id: true, name: true, team: { select: { deletedAt: true } } } }'],
    ['parent: { select: { id: true, name: true, email: true } }'],
    ['child: { select: { name: true } }'],
    ['managedBy: { select: { id: true, name: true } }'],
    // A same-file constant referenced by name is checked through its body.
    ['const PARENT_SELECT = { id: true, name: true } satisfies Prisma.UserSelect;\nparent: { select: PARENT_SELECT }'],
    ['const X: Prisma.UserSelect = {\n  name: true,\n};\nconst I = { user: { select: X } };'],
  ])('flags %j', (source) => {
    expect(findUserSelectsWithoutDeletedAt(source)).toHaveLength(1);
  });

  it.each([
    ['player: { select: { id: true, name: true, deletedAt: true } }'],
    ['user: { select: USER_SUMMARY_WITH_EMAIL_SELECT }'],
    ['author: { select: { ...USER_SUMMARY_SELECT, profilePictureUrl: true } }'],
    ['invitedBy: { select: { name: true, deletedAt: true } }'],
    ['user: { select: { email: true } }'],
    ['team: { select: { id: true, name: true } }'],
    ['// player: { select: { id: true, name: true } }'],
    ['/* user: { select: { name: true } } */'],
    ['const PARENT_SELECT = { id: true, name: true, deletedAt: true };\nparent: { select: PARENT_SELECT }'],
    ['const P = { ...USER_SUMMARY_SELECT, profilePictureUrl: true };\nauthor: { select: P }'],
    // Imported constant: checked where it is declared, not here.
    ['author: { select: IMPORTED_SELECT }'],
    ['league: { select: LEAGUE_SUMMARY_SELECT }\nconst LEAGUE_SUMMARY_SELECT = { id: true, name: true };'],
  ])('allows %j', (source) => {
    expect(findUserSelectsWithoutDeletedAt(source)).toEqual([]);
  });
});
