/**
 * Resend (supersede) against a REAL Postgres (#678, #715).
 *
 * #678: a lapsed PENDING invitation used to be flipped to EXPIRED in a
 * separate statement before the supersede transaction, whose inheritance
 * lookup read PENDING rows only, so the replacement lost the coach-set
 * jersey/position/message. The player opening the dead link first (which also
 * flips the row) reached the same state. Both orderings are exercised here.
 *
 * #715: a Resend inside the per-recipient cooldown is refused with 429 and
 * leaves the live row untouched.
 *
 * Every row is namespaced by a per-run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomBytes, randomUUID } from 'node:crypto';
import { removeTestRows } from '../support/test-leftovers';
import prisma from '../../src/models';
import { InvitationService, INVITATION_RESEND_COOLDOWN_MS } from '../../src/services/invitation-service';
import { ResendCooldownError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';

jest.setTimeout(30000);

const RUN = randomUUID().slice(0, 8);
const DAY_MS = 24 * 60 * 60 * 1000;

let teamId: string;
let coachId: string;

async function mkUser(local: string, extra: Record<string, unknown> = {}): Promise<string> {
  const user = await prisma.user.create({
    data: { name: `${local}-${RUN}`, email: `${local}.${RUN}@example.test`, role: 'PLAYER', ...extra },
    select: { id: true },
  });
  return user.id;
}

/** A claimed account that is not on the roster: the case-3 invitee whose
 * roster row is born from the invitation at accept. */
async function mkInvitee(local: string): Promise<string> {
  return mkUser(local, { workosUserId: `workos-${local}-${RUN}` });
}

async function mkInvitation(
  playerId: string,
  opts: { status: 'PENDING' | 'EXPIRED'; createdAt: Date; expiresAt: Date }
): Promise<string> {
  const row = await prisma.teamInvitation.create({
    data: {
      teamId,
      playerId,
      invitedById: coachId,
      token: randomBytes(32).toString('base64url'),
      jerseyNumber: 23,
      position: 'Guard',
      message: 'Welcome!',
      ...opts,
    },
    select: { id: true },
  });
  return row.id;
}

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
  const league = await prisma.league.create({ data: { name: `ZZ-supersede-${RUN}` }, select: { id: true } });
  const season = await prisma.season.create({
    data: { leagueId: league.id, name: `S-${RUN}`, isActive: true },
    select: { id: true },
  });
  const team = await prisma.team.create({
    data: { name: `Supersede-${RUN}`, season: { connect: { id: season.id } }, lineage: { create: {} } },
    select: { id: true },
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
  await prisma.teamStaff.create({ data: { teamId, userId: coachId, roleId: head.id } });
});

afterAll(async () => {
  await removeTestRows(prisma, { run: RUN });
  await prisma.$disconnect();
  jest.restoreAllMocks();
});

async function rowsFor(playerId: string): Promise<
  { id: string; status: string; jerseyNumber: number | null; position: string | null; message: string | null }[]
> {
  return prisma.teamInvitation.findMany({
    where: { teamId, playerId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, jerseyNumber: true, position: true, message: true },
  });
}

describe('supersede inheritance from a lapsed invitation (#678)', () => {
  it('a bare resend on a lapsed PENDING row carries its jersey/position/message and expires it', async () => {
    const playerId = await mkInvitee('lapsed');
    const oldId = await mkInvitation(playerId, {
      status: 'PENDING',
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      expiresAt: new Date(Date.now() - DAY_MS),
    });

    const { invitation } = await InvitationService.createInvitation(
      teamId,
      { playerId, supersede: true },
      coachId
    );

    const rows = await rowsFor(playerId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === oldId)?.status).toBe('EXPIRED');
    expect(rows.find((r) => r.id === invitation.id)).toEqual(
      expect.objectContaining({ status: 'PENDING', jerseyNumber: 23, position: 'Guard', message: 'Welcome!' })
    );
  });

  it('a bare resend after the row was already flipped to EXPIRED still inherits', async () => {
    const playerId = await mkInvitee('flipped');
    await mkInvitation(playerId, {
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - 8 * DAY_MS),
      expiresAt: new Date(Date.now() - DAY_MS),
    });

    const { invitation } = await InvitationService.createInvitation(
      teamId,
      { playerId, supersede: true },
      coachId
    );

    const created = (await rowsFor(playerId)).find((r) => r.id === invitation.id);
    expect(created).toEqual(
      expect.objectContaining({ status: 'PENDING', jerseyNumber: 23, position: 'Guard', message: 'Welcome!' })
    );
  });
});

describe('resend cooldown (#715)', () => {
  it('refuses a resend inside the cooldown and leaves the live row untouched', async () => {
    const playerId = await mkInvitee('cooldown');
    const liveId = await mkInvitation(playerId, {
      status: 'PENDING',
      createdAt: new Date(Date.now() - 30 * 1000),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
    });

    await expect(
      InvitationService.createInvitation(teamId, { playerId, supersede: true }, coachId)
    ).rejects.toBeInstanceOf(ResendCooldownError);

    const rows = await rowsFor(playerId);
    expect(rows).toEqual([expect.objectContaining({ id: liveId, status: 'PENDING' })]);
  });

  it('allows the resend once the cooldown has passed', async () => {
    const playerId = await mkInvitee('aftercooldown');
    const liveId = await mkInvitation(playerId, {
      status: 'PENDING',
      createdAt: new Date(Date.now() - INVITATION_RESEND_COOLDOWN_MS - 5000),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
    });

    const { invitation } = await InvitationService.createInvitation(
      teamId,
      { playerId, supersede: true },
      coachId
    );

    const rows = await rowsFor(playerId);
    expect(rows.find((r) => r.id === liveId)?.status).toBe('EXPIRED');
    expect(rows.find((r) => r.id === invitation.id)).toEqual(
      expect.objectContaining({ status: 'PENDING', jerseyNumber: 23 })
    );
  });
});
