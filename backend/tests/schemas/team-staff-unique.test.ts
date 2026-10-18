/**
 * Schema test: one staff role per user per team (#463).
 *
 * The data model, the permission lookup and the API agree on single-role:
 * `TeamStaff` is unique on [teamId, userId], `getTeamPermissions` reads that
 * one row, and `POST /teams/:teamId/staff` answers 400 for a second role. The
 * P2002 mapping in `TeamService.addStaffMember` names the index by string, so
 * this suite pins the Prisma schema, the migration that creates the index and
 * the service's conflict target to the same name; a rename of any one fails
 * here instead of turning the race-loser's 400 into a 500.
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const BACKEND = path.resolve(__dirname, '../..');
const SCHEMA = readFileSync(path.join(BACKEND, 'prisma/schema.prisma'), 'utf8');
const MIGRATIONS = path.join(BACKEND, 'prisma/migrations');
const TEAM_SERVICE = readFileSync(path.join(BACKEND, 'src/services/team-service.ts'), 'utf8');
const INDEX = 'TeamStaff_teamId_userId_key';
const OLD_INDEX = 'TeamStaff_teamId_userId_roleId_key';

/** The body of `model <name> { … }` in the Prisma schema. */
function modelBlock(name: string): string {
  const match = SCHEMA.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

/** Every migration.sql in apply order (directory names sort by timestamp). */
function migrationSql(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8') }));
}

/** The last migration whose SQL mentions `needle`. */
function lastMigrationWith(needle: string): { name: string; sql: string } {
  const found = migrationSql().filter(({ sql }) => sql.includes(needle));
  if (found.length === 0) throw new Error(`no migration mentions ${needle}`);
  return found[found.length - 1];
}

describe('TeamStaff: one role per user per team (#463)', () => {
  const block = modelBlock('TeamStaff');
  const uniques = [...block.matchAll(/@@unique\(\[([^\]]*)\]/g)].map((m) =>
    m[1].split(',').map((field) => field.trim())
  );

  it('declares exactly one compound unique, on [teamId, userId]', () => {
    expect(uniques).toEqual([['teamId', 'userId']]);
  });

  it('no longer lets the role widen the key', () => {
    expect(uniques.some((fields) => fields.includes('roleId'))).toBe(false);
  });

  it('the last migration that touches the index drops the old one and creates the new one', () => {
    const touching = migrationSql().filter(
      ({ sql }) => sql.includes(INDEX) || sql.includes(OLD_INDEX)
    );
    const last = touching[touching.length - 1];

    expect(last.sql).toContain(`DROP INDEX "${OLD_INDEX}"`);
    expect(last.sql).toMatch(
      new RegExp(`CREATE UNIQUE INDEX "${INDEX}" ON "TeamStaff"\\("teamId", "userId"\\)`)
    );
  });

  it('removes extra rows between the DELETE sentinels, before creating the index', () => {
    const { sql } = lastMigrationWith(INDEX);
    const begin = sql.indexOf('-- BEGIN DELETE');
    const deleteAt = sql.indexOf('DELETE FROM "TeamStaff"', begin);
    const end = sql.indexOf('-- END DELETE');
    const createAt = sql.indexOf(`CREATE UNIQUE INDEX "${INDEX}"`);

    expect(begin).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(begin);
    expect(end).toBeGreaterThan(deleteAt);
    expect(createAt).toBeGreaterThan(end);
  });

  it('keeps the most privileged role: role type, then flag count, then oldest, then lowest id', () => {
    const { sql } = lastMigrationWith(INDEX);
    const order = sql.slice(sql.indexOf('ORDER BY'), sql.indexOf(') AS rn'));
    const at = (needle: string): number => {
      const i = order.indexOf(needle);
      if (i < 0) throw new Error(`ORDER BY does not contain ${needle}`);
      return i;
    };

    const ranks = [
      "WHEN 'HEAD_COACH' THEN 0",
      "WHEN 'ASSISTANT_COACH' THEN 1",
      "WHEN 'TEAM_MANAGER' THEN 2",
      'ELSE 3',
    ].map(at);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const keys = ['END ASC', '"canShareStats"::int) DESC', 'ts."createdAt" ASC', 'ts."id" ASC'].map(at);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it('drops the [teamId] index, which the unique index\'s leading column covers', () => {
    expect(block).not.toMatch(/@@index\(\[teamId\]\)/);
    expect(lastMigrationWith(INDEX).sql).toContain('DROP INDEX "TeamStaff_teamId_idx"');
  });

  it('TeamService.addStaffMember maps a P2002 on that same index to its 400', () => {
    expect(TEAM_SERVICE).toContain(`'${INDEX}'`);
    expect(TEAM_SERVICE).not.toContain(OLD_INDEX);
  });
});
