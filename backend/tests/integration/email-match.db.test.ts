/**
 * Email lookups against a REAL Postgres (#572).
 *
 * Prisma compiles `{ equals, mode: 'insensitive' }` to ILIKE with the value as
 * the pattern, so `_` matched any character and `%` any run of characters: a
 * lookup for `first_last@…` also found `firstXlast@…`. A mocked test cannot
 * see that, which is how it reached production.
 *
 * Every flow below plants a DECOY account whose address differs from the
 * target only where the target has a `_`, then proves the flow lands on the
 * exact address and never on the decoy. The helper block also pins the two
 * properties the fix must keep: mixed-case stored addresses still match, and
 * the escape stays single (it fails if a future Prisma escapes by itself).
 *
 * CI provides Postgres and runs `prisma migrate deploy`; locally it uses
 * whatever DATABASE_URL points at (docker-compose). Every row is namespaced by
 * a per-run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomUUID } from 'node:crypto';
import { removeTestRows } from '../support/test-leftovers';
import prisma from '../../src/models';
import { AccountService } from '../../src/services/account-service';
import { GuardianService } from '../../src/services/guardian-service';
import { InvitationService } from '../../src/services/invitation-service';
import { TeamService } from '../../src/services/team-service';
import { NotFoundError } from '../../src/utils/errors';
import { emailEquals } from '../../src/utils/email-match';
import { logger } from '../../src/utils/logger';
import { findActiveUserIdByEmail } from '../../scripts/data-subject-lookup';

jest.setTimeout(30000);

const RUN = randomUUID().slice(0, 8);
const userIds: string[] = [];

/** `<local>.<run>@example.test` — the run id keeps reruns and parallel CI apart. */
function address(local: string): string {
  return `${local}.${RUN}@example.test`;
}

async function mkUser(local: string, extra: Record<string, unknown> = {}): Promise<string> {
  const user = await prisma.user.create({
    data: { name: `${local}-${RUN}`, email: address(local), role: 'PLAYER', ...extra },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

/** Track accounts a flow created, so afterAll removes them. */
async function trackByEmail(email: string): Promise<{ id: string; email: string | null } | null> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (user && !userIds.includes(user.id)) userIds.push(user.id);
  return user;
}

let teamId: string;
let coachId: string;
let kidId: string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new Error(
      'This suite needs a real Postgres. Start one and apply migrations:\n' +
        '  docker-compose up -d && cd backend && npx prisma migrate deploy\n' +
        `DATABASE_URL=${process.env.DATABASE_URL ?? '(unset)'}`,
      { cause: err }
    );
  }
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  coachId = await mkUser('coach', { role: 'COACH', workosUserId: `workos-coach-${RUN}` });

  const league = await prisma.league.create({ data: { name: `ZZ-email-match-${RUN}` }, select: { id: true } });
  const season = await prisma.season.create({
    data: { leagueId: league.id, name: `S-${RUN}`, isActive: true },
    select: { id: true },
  });
  const team = await prisma.team.create({
    data: { name: `EmailMatch-${RUN}`, season: { connect: { id: season.id } }, lineage: { create: {} } },
    select: { id: true, lineageId: true },
  });
  teamId = team.id;

  const head = await prisma.teamRole.create({
    data: {
      teamId,
      type: 'HEAD_COACH',
      name: 'Head Coach',
      canManageTeam: true,
      canManageRoster: true,
      canTrackStats: true,
      canViewStats: true,
      canShareStats: true,
    },
    select: { id: true },
  });
  await prisma.teamRole.create({
    data: { teamId, type: 'ASSISTANT_COACH', name: 'Assistant Coach', canManageTeam: true, canManageRoster: true },
  });
  await prisma.teamStaff.create({ data: { teamId, userId: coachId, roleId: head.id } });

  kidId = await mkUser('kid', { isManaged: true, managedById: coachId, email: null });
  await prisma.teamMember.create({ data: { teamId, playerId: kidId } });
});

afterAll(async () => {
  // By run id, not only by the ids collected along the way: a test that
  // throws before it records a row still cleans up (#584). The collected
  // user ids stay for rows that lost their run id on the way, such as an
  // account that was deleted and is now a tombstone.
  await removeTestRows(prisma, { run: RUN, alsoUserIds: userIds });
  await prisma.$disconnect();
  jest.restoreAllMocks();
});

describe('emailEquals against Postgres', () => {
  // Sorted here, never by the database: where "_" sorts relative to a letter
  // depends on the collation, and CI's differs from a local docker-compose.
  async function holders(lookup: string): Promise<string[]> {
    const rows = await prisma.user.findMany({
      where: { email: emailEquals(lookup), id: { in: userIds } },
      select: { email: true },
    });
    return rows.map((row) => row.email as string).sort();
  }

  beforeAll(async () => {
    await mkUser('help_under');
    await mkUser('helpXunder');
    await mkUser('help%pct');
    await mkUser('helpANYTHINGpct');
    await mkUser('Help.Mixed', { email: `Help.Mixed.${RUN}@Example.Test` });
    await mkUser('help\\slash');
  });

  it('matches an underscore literally, not as "any one character"', async () => {
    expect(await holders(address('help_under'))).toEqual([address('help_under')]);
  });

  it('matches a percent sign literally, not as "any run of characters"', async () => {
    expect(await holders(address('help%pct'))).toEqual([address('help%pct')]);
  });

  it('matches a backslash literally', async () => {
    expect(await holders(address('help\\slash'))).toEqual([address('help\\slash')]);
  });

  it('still ignores case, in both directions', async () => {
    const stored = `Help.Mixed.${RUN}@Example.Test`;
    expect(await holders(stored.toLowerCase())).toEqual([stored]);
    expect(await holders(stored.toUpperCase())).toEqual([stored]);
    expect(await holders(address('HELP_UNDER'))).toEqual([address('help_under')]);
  });

  it('the unescaped filter really is a pattern: this is the bug being guarded', async () => {
    // If this ever returns one row, Prisma has started escaping by itself and
    // emailEquals must stop, or addresses containing "_" stop matching.
    const rows = await prisma.user.findMany({
      // Deliberately the raw filter — built from variables so the source guard
      // (tests/utils/email-match-guard.test.ts scans `src/` and `scripts/`,
      // never `tests/`) is not the thing under test here.
      where: { email: { equals: address('help_under'), mode: 'insensitive' }, id: { in: userIds } },
      select: { email: true },
    });
    expect(rows.map((row) => row.email).sort()).toEqual(
      [address('helpXunder'), address('help_under')].sort()
    );
  });
});

describe('Add Player: the invitation lands on the typed address', () => {
  it('creates a new account for first_last@, never reusing firstXlast@', async () => {
    const decoy = await mkUser('addXplayer', { workosUserId: `workos-decoy-add-${RUN}` });

    const result = await InvitationService.addRosterPlayer(
      teamId,
      { name: 'Underscore Player', playerEmail: address('add_player') },
      coachId
    );

    const created = await trackByEmail(address('add_player'));
    expect(created).not.toBeNull();
    expect(created?.id).not.toBe(decoy);
    // The decoy is a claimed account: matching it would have been the
    // invitation-only path (`rostered: false`) addressed to a stranger.
    expect(result.rostered).toBe(true);
    expect(result.member?.playerId).toBe(created?.id);
    expect(await prisma.teamInvitation.count({ where: { teamId, playerId: decoy } })).toBe(0);
    expect(await prisma.teamMember.count({ where: { teamId, playerId: decoy } })).toBe(0);
  });

  it('still finds an existing account whose stored address differs only in case', async () => {
    const existing = await mkUser('Case.Player', {
      email: `Case.Player.${RUN}@Example.Test`,
      workosUserId: `workos-case-${RUN}`,
    });

    const result = await InvitationService.addRosterPlayer(
      teamId,
      { name: 'Case Player', playerEmail: address('case.player') },
      coachId
    );

    // Claimed account: invitation only, no duplicate account.
    expect(result.rostered).toBe(false);
    expect(result.invitation?.playerId).toBe(existing);
    expect(await prisma.user.count({ where: { email: address('case.player') } })).toBe(0);
  });
});

describe('Add staff by email', () => {
  it('answers 404 for first_last@ when only firstXlast@ has an account', async () => {
    const decoy = await mkUser('staffXcoach', { role: 'COACH' });

    await expect(
      TeamService.addStaffMember(teamId, { email: address('staff_coach'), roleType: 'ASSISTANT_COACH' }, coachId)
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await prisma.teamStaff.count({ where: { teamId, userId: decoy } })).toBe(0);
  });

  it('adds the exact account, whatever case the coach typed', async () => {
    const assistant = await mkUser('staff_real', { role: 'COACH' });

    const staff = await TeamService.addStaffMember(
      teamId,
      { email: address('STAFF_REAL'), roleType: 'ASSISTANT_COACH' },
      coachId
    );

    expect(staff.userId).toBe(assistant);
  });
});

describe('Guardian invitations', () => {
  it('creates a new account for the parent, never linking firstXlast@ to the child', async () => {
    const decoy = await mkUser('momXsmith');

    const invitation = await GuardianService.inviteGuardian(
      teamId,
      kidId,
      { email: address('mom_smith'), relationship: 'MOTHER' },
      coachId
    );

    const parent = await trackByEmail(address('mom_smith'));
    expect(parent).not.toBeNull();
    expect(parent?.id).not.toBe(decoy);
    expect(invitation.invitedEmail).toBe(address('mom_smith'));
  });

  // In the two lookups below the pattern is the SIGNED-IN user's own address,
  // so the account with the "_" is the one that must not see, export or expire
  // an invitation sent to the look-alike. The look-alike is lower-case here
  // because invite flows store the address they are given in lower case.
  it('lists a pending invitation for the adult it names, and for nobody else', async () => {
    const underscore = await mkUser('dad_jones');
    await GuardianService.inviteGuardian(
      teamId,
      kidId,
      { email: address('dadxjones'), relationship: 'FATHER' },
      coachId
    );
    const invited = await trackByEmail(address('dadxjones'));

    expect(await GuardianService.listPendingForUser(underscore)).toEqual([]);
    expect(await GuardianService.listPendingForUser(invited?.id as string)).toHaveLength(1);
  });
});

describe('Operator data-subject lookup (scripts/data-subject-request.ts)', () => {
  it('resolves first_last@ to that row, never to firstXlast@', async () => {
    const target = await mkUser('dsr_target');
    await mkUser('dsrXtarget');

    expect(await findActiveUserIdByEmail(prisma, address('dsr_target'))).toBe(target);
  });

  it('matches a mixed-case stored address from the lower-cased request, after trimming', async () => {
    const stored = await mkUser('DSR.Mixed', { email: `DSR.Mixed.${RUN}@Example.Test` });

    expect(await findActiveUserIdByEmail(prisma, `  ${address('dsr.mixed').toUpperCase()} `)).toBe(stored);
  });

  it('refuses when two active accounts hold the address in different case', async () => {
    await mkUser('dsr.dup', { email: `dsr.dup.${RUN}@example.test` });
    await mkUser('DSR.Dup', { email: `DSR.Dup.${RUN}@Example.Test` });

    await expect(findActiveUserIdByEmail(prisma, address('dsr.dup'))).rejects.toThrow(
      '2 active accounts match'
    );
  });

  it('ignores a tombstoned row and reports no account', async () => {
    await mkUser('dsr_gone', { email: null, deletedAt: new Date(), name: `dsr_gone-${RUN}` });

    await expect(findActiveUserIdByEmail(prisma, address('dsr_gone'))).rejects.toThrow('No active account');
  });
});

describe('Account deletion and export', () => {
  it('neither exports nor expires a guardian invitation addressed to a look-alike address', async () => {
    const underscore = await mkUser('aunt_lee');
    await GuardianService.inviteGuardian(
      teamId,
      kidId,
      { email: address('auntxlee'), relationship: 'OTHER' },
      coachId
    );
    await trackByEmail(address('auntxlee'));
    const pending = { teamId, invitedEmail: address('auntxlee'), status: 'PENDING' as const };
    expect(await prisma.guardianInvitation.count({ where: pending })).toBe(1);

    const exported = await AccountService.exportUserData(underscore);
    expect(exported.guardianInvitations).toEqual([]);

    await AccountService.deleteAccount(underscore, { actorId: underscore, mode: 'self' });

    // Still pending, still addressed to the person it was sent to.
    expect(await prisma.guardianInvitation.count({ where: pending })).toBe(1);
  });

  it('does export and expire the invitations addressed to the account itself', async () => {
    const leaver = await mkUser('Uncle_Bo', { email: `Uncle_Bo.${RUN}@Example.Test` });
    await prisma.guardianInvitation.create({
      data: {
        teamId,
        childId: kidId,
        invitedById: coachId,
        invitedEmail: address('uncle_bo'),
        relationship: 'OTHER',
        token: `tok-${RUN}-uncle`,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const exported = await AccountService.exportUserData(leaver);
    expect(exported.guardianInvitations).toHaveLength(1);

    await AccountService.deleteAccount(leaver, { actorId: leaver, mode: 'self' });

    expect(
      await prisma.guardianInvitation.count({ where: { teamId, token: `tok-${RUN}-uncle`, status: 'EXPIRED' } })
    ).toBe(1);
  });
});
