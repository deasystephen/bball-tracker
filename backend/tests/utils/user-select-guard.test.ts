/**
 * Guard for #813: every user embedded in a payload carries `deletedAt`.
 *
 * Mobile renders names through `displayName`, which reads `deletedAt`; a
 * payload without it shows the stored English "Deleted user" untranslated
 * (CLAUDE.md: read tombstone state from `deletedAt`, never from the name).
 * #642 fixed the selects one by one and missed six; this suite fails on any
 * inline `select: { … name: true … }` on a `user`, `player`, `author` or
 * `invitedBy` key (`staff.user` included) in `src/` that neither selects
 * `deletedAt: true` nor spreads a `USER_SUMMARY` constant from
 * `src/utils/user-select.ts`. A `select: SOME_CONSTANT` reference is not
 * inline and is checked where the constant is declared.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { sourceFiles, stripComments } from '../support/source-scan';
import { USER_SUMMARY_SELECT, USER_SUMMARY_WITH_EMAIL_SELECT } from '../../src/utils/user-select';

const BACKEND = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND, 'src');
const GENERATED = path.join(SRC, 'generated');

const USER_KEY_SELECT = /\b(?:user|player|author|invitedBy)\s*:\s*\{\s*select\s*:\s*\{/g;

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

/** Inline user selects that expose a name without the tombstone signal. */
export function findUserSelectsWithoutDeletedAt(source: string): string[] {
  const code = stripComments(source);
  const offenders: string[] = [];
  for (const match of code.matchAll(USER_KEY_SELECT)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const keys = topLevel(blockBody(code, open));
    if (!/\bname\s*:\s*true\b/.test(keys)) continue;
    if (/\bdeletedAt\s*:\s*true\b/.test(keys) || /\.\.\.\s*USER_SUMMARY\w*/.test(keys)) continue;
    offenders.push(`${match[0]}${keys.replace(/\s+/g, ' ')}}`);
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
  it.each([
    ['player: { select: { id: true, name: true } }'],
    ['user: {\n  select: {\n    id: true,\n    name: true,\n    email: true,\n  },\n}'],
    ['author: { select: { id: true, name: true, profilePictureUrl: true } }'],
    ['invitedBy: { select: { name: true } }'],
    ['staff: { include: { user: { select: { id: true, name: true } }, role: true } }'],
    // A nested relation's deletedAt is not the user's own.
    ['player: { select: { id: true, name: true, team: { select: { deletedAt: true } } } }'],
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
  ])('allows %j', (source) => {
    expect(findUserSelectsWithoutDeletedAt(source)).toEqual([]);
  });
});
