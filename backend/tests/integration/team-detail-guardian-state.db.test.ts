/**
 * `GET /teams/:id` parent-invitation state (#1082) against a REAL Postgres.
 *
 * A child under 13 has no invitation of their own; the parent has a
 * `GuardianInvitation`. The roster chip reads that state from the team detail
 * payload. The mocked service suite proves the shaping; this proves the select
 * itself: only PENDING rows come back, a linked guardian is reported once per
 * player, nothing rides on the player object, and a caller who does not manage
 * the roster gets neither list.
 *
 * Every row is namespaced by the fixture run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomBytes } from 'node:crypto';
import prisma from '../../src/models';
import { TeamService } from '../../src/services/team-service';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'team-detail-guardian');
const DAY_MS = 24 * 60 * 60 * 1000;

let org: Org;
let coachId: string;
let teammateId: string;
let invitedChildId: string;
let linkedChildId: string;
let bareChildId: string;
let pendingId: string;

async function guardianInvitation(childId: string, status: 'PENDING' | 'EXPIRED', local: string): Promise<string> {
  const row = await prisma.guardianInvitation.create({
    data: {
      token: randomBytes(32).toString('base64url'),
      childId,
      teamId: org.teamId,
      invitedEmail: `${local}.${fx.run}@example.test`,
      relationship: 'MOTHER',
      invitedById: coachId,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      status,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  await fx.requireDatabase();

  org = await fx.org('team');
  coachId = await fx.user('coach', 'COACH');
  await fx.staff(coachId, org);

  teammateId = await fx.user('teammate', 'PLAYER');
  await fx.member(teammateId, org);

  invitedChildId = await fx.user('invited-child', 'PLAYER');
  linkedChildId = await fx.user('linked-child', 'PLAYER');
  bareChildId = await fx.user('bare-child', 'PLAYER');
  for (const childId of [invitedChildId, linkedChildId, bareChildId]) {
    await fx.member(childId, org);
  }

  pendingId = await guardianInvitation(invitedChildId, 'PENDING', 'mum');
  // A superseded invitation is history, not state: it must not come back.
  await guardianInvitation(invitedChildId, 'EXPIRED', 'mum-old');

  // Two linked guardians still report the player once.
  const mother = await fx.user('mother', 'PARENT');
  const father = await fx.user('father', 'PARENT');
  await prisma.guardian.create({ data: { parentId: mother, childId: linkedChildId, relationship: 'MOTHER', isPrimary: true } });
  await prisma.guardian.create({ data: { parentId: father, childId: linkedChildId, relationship: 'FATHER' } });
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('team detail carries the parent invitation state for roster managers (#1082)', () => {
  it('returns the pending parent invitation and the linked players to a coach, never on the player object', async () => {
    const team = await TeamService.getTeamById(org.teamId, coachId);

    expect(team.guardianInvitations).toHaveLength(1);
    expect(team.guardianInvitations[0]).toMatchObject({ id: pendingId, playerId: invitedChildId, status: 'PENDING' });
    expect(Object.keys(team.guardianInvitations[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'playerId', 'status']);
    expect(team.guardianLinkedPlayerIds).toEqual([linkedChildId]);

    for (const member of team.members) {
      expect(member.player).not.toHaveProperty('guardiansAsChild');
      expect(member.player).not.toHaveProperty('guardianInvitationsAsChild');
    }
    // The coach still gets roster emails.
    expect(team.members.find((m) => m.playerId === bareChildId)?.player).toHaveProperty('email');
  });

  it('returns neither list to a teammate who does not manage the roster', async () => {
    const team = await TeamService.getTeamById(org.teamId, teammateId);

    expect(team.guardianInvitations).toEqual([]);
    expect(team.guardianLinkedPlayerIds).toEqual([]);
    for (const member of team.members) {
      expect(member.player).not.toHaveProperty('guardiansAsChild');
      expect(member.player).not.toHaveProperty('guardianInvitationsAsChild');
      expect(member.player).not.toHaveProperty('email');
    }
  });
});
