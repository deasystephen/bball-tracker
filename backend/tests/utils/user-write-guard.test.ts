/**
 * Guard for #643: every write onto a `User` row is guarded by `deletedAt IS NULL`.
 *
 * `AccountService.deleteAccount` tombstones a row it cannot erase (other rows
 * reference it). Every other write path reads the row unlocked before writing,
 * so a write that raced the deletion, or an admin editing a stale id, would
 * re-populate an erased account. The rule lives in CLAUDE.md and
 * `docs/architecture/account-deletion.md`; this suite turns it from remembered
 * into enforced: any `user.update(`, `user.updateMany(`, `user.delete(`,
 * `user.deleteMany(` or `user.upsert(` in `src/` whose `where` is not an
 * object literal naming `deletedAt` fails.
 *
 * Allowlisted: `services/account-service.ts` only. It writes the tombstone
 * itself, scrubs `managedById` off the rows the deleted account managed, and
 * hard-deletes an account nothing references any more (#529), all under the
 * FOR UPDATE lock it takes on the row. No other file hard-deletes a User.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { sourceFiles, stripComments } from '../support/source-scan';

const BACKEND = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND, 'src');
const ALLOWLIST = new Set([path.join(SRC, 'services/account-service.ts')]);

const USER_WRITE = /\buser\.(update|updateMany|delete|deleteMany|upsert)\(/g;

/** The text from `source[open]` (an opening bracket) to its matching close, inclusive. */
function balanced(source: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}' };
  const opener = source[open];
  const closer = pairs[opener];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opener) depth++;
    else if (source[i] === closer) {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/**
 * Every `User` write call (see `USER_WRITE`) whose `where` is not an object
 * literal containing `deletedAt`, as the call's argument text.
 */
export function findUnguardedUserWrites(source: string): string[] {
  const code = stripComments(source);
  const offenders: string[] = [];
  for (const match of code.matchAll(USER_WRITE)) {
    const args = balanced(code, (match.index ?? 0) + match[0].length - 1);
    const where = /\bwhere\s*:\s*/.exec(args);
    if (!where) {
      offenders.push(args);
      continue;
    }
    const start = where.index + where[0].length;
    if (args[start] !== '{' || !/\bdeletedAt\b/.test(balanced(args, start))) {
      offenders.push(args);
    }
  }
  return offenders;
}

describe('every User write is guarded by deletedAt (#643)', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = sourceFiles(SRC);
  });

  it('scans the backend source', () => {
    // A guard that reads nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(SRC, 'services/player-service.ts'));
  });

  it('finds no User update outside the allowlist whose where lacks deletedAt', () => {
    const offenders = files
      .filter((file) => !ALLOWLIST.has(file))
      .flatMap((file) =>
        findUnguardedUserWrites(readFileSync(file, 'utf8')).map(
          (args) => `${path.relative(BACKEND, file)}: ${args.replace(/\s+/g, ' ').slice(0, 160)}`
        )
      );

    expect(offenders).toEqual([]);
  });

  it('sees real User writes (the scan is not vacuous)', () => {
    const writes = files.flatMap((file) => readFileSync(file, 'utf8').match(USER_WRITE) ?? []);
    expect(writes.length).toBeGreaterThan(5);
  });

  it('the allowlisted tombstone write is the reason for the allowlist', () => {
    // If account-service stops writing an unguarded User row, drop it from the allowlist.
    const source = readFileSync(path.join(SRC, 'services/account-service.ts'), 'utf8');
    expect(findUnguardedUserWrites(source).length).toBeGreaterThan(0);
  });
});

describe('the guard pattern', () => {
  it.each([
    ['prisma.user.update({ where: { id }, data: { name } })', 1],
    ['tx.user.updateMany({ where: { id, workosUserId: null }, data })', 1],
    ['prisma.user.update({ where: filter, data })', 1],
    ['prisma.user.updateMany({ data })', 1],
    ['prisma.user.updateMany({ where: { id, deletedAt: null }, data })', 0],
    ['tx.user.updateMany({\n  where: {\n    email: { in: emails },\n    deletedAt: null,\n  },\n  data: { x: 1 },\n})', 0],
    ['prisma.user.update({ where: { id }, data: { deletedAt: new Date() } })', 1],
    ['// prisma.user.update({ where: { id } })', 0],
    ['prisma.teamUser.update({ where: { id } })', 0],
    ['prisma.user.findUnique({ where: { id } })', 0],
    ['prisma.user.delete({ where: { id } })', 1],
    ['tx.user.deleteMany({ where: { managedById: id } })', 1],
    ["prisma.user.upsert({ where: { email }, create: {}, update: {} })", 1],
    ['prisma.user.delete({ where: { id, deletedAt: null } })', 0],
    ['prisma.user.deleteMany({ where: { id: { in: ids }, deletedAt: null } })', 0],
  ])('%j → %i offender(s)', (source, count) => {
    expect(findUnguardedUserWrites(source)).toHaveLength(count);
  });
});
