/**
 * Which callers receive which email addresses, through the route and the real
 * service (#654, #661, #679, #683). The per-endpoint API suites mock the whole
 * service, so they cannot show what a payload carries; this file mocks only the
 * database, and every mocked read is projected through the `select` the
 * service passes, so a select that grows an `email` key fails here.
 *
 * Rule (CLAUDE.md, emails in payloads): roster `player.email` only for callers
 * with `canManageRoster`; staff emails for every team member.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const GAME_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const ANNOUNCEMENT_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
const INVITATION_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';

const COACH = { id: 'f6a7b8c9-d0e1-4345-a789-0abcdef01234', name: 'Coach Carter', email: 'coach@example.test' };
const PLAYER = { id: 'a7b8c9d0-e1f2-4456-a890-abcdef012345', name: 'Pat Player', email: 'pat@example.test' };
const TEAMMATE = { id: 'b8c9d0e1-f2a3-4567-a901-bcdef0123456', name: 'Terry Mate', email: 'terry@example.test' };
const PARENT = { id: 'c9d0e1f2-a3b4-4678-a012-cdef01234567', name: 'Gloria Parent', email: 'gloria@example.test' };
const CHILD = { id: 'd0e1f2a3-b4c5-4789-a123-def012345678', name: 'Kid Parent', email: 'kid@example.test' };

let callerId = PLAYER.id;

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = { id: callerId, email: 'caller@example.test', name: 'Caller', role: 'PLAYER' };
    next();
  }),
}));

type Row = Record<string, unknown>;
type Spec = Record<string, unknown>;

/** What Prisma returns for `row` under `select`. */
function project(row: Row, select: Spec): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) out[key] = row[key];
    else if (value && typeof value === 'object') out[key] = shape(row[key] as Row, value as Spec);
  }
  return out;
}

/** What Prisma returns for `row` under `include` (scalars plus the relations named). */
function include(row: Row, spec: Spec): Row {
  const out: Row = { ...row };
  for (const [key, value] of Object.entries(spec)) {
    if (value && typeof value === 'object') out[key] = shape(row[key] as Row, value as Spec);
  }
  return out;
}

function shape(row: Row, args: Spec): Row {
  if (args.select) return project(row, args.select as Spec);
  if (args.include) return include(row, args.include as Spec);
  return row;
}

const ALL_FLAGS = {
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

/**
 * Who `callerId` is on the team. `coach` holds a head-coach staff row;
 * `member` is rostered; `guardianOf` is the set of children the caller is a
 * guardian of (the child is rostered).
 */
function givenTeamStanding(standing: { coach?: string[]; member?: string[]; guardianOf?: Record<string, string> }): void {
  const coaches = new Set(standing.coach ?? []);
  const members = new Set(standing.member ?? []);
  const guardianOf = standing.guardianOf ?? {};

  (mockPrisma.user.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: string } }) => {
    const user = [COACH, PLAYER, TEAMMATE, PARENT, CHILD].find((u) => u.id === where.id);
    return Promise.resolve(user ? { ...user, role: 'PLAYER' } : null);
  });
  // Team exists; nobody is a league admin.
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
    id: TEAM_ID,
    name: 'Hoops',
    season: { league: { admins: [] } },
  });
  (mockPrisma.teamStaff.findFirst as jest.Mock).mockImplementation(({ where }: { where: { userId: string } }) =>
    Promise.resolve(coaches.has(where.userId) ? { id: 'staff-1' } : null)
  );
  (mockPrisma.teamMember.findUnique as jest.Mock).mockImplementation(
    ({ where }: { where: { teamId_playerId: { playerId: string } } }) =>
      Promise.resolve(members.has(where.teamId_playerId.playerId) ? { id: 'member-1' } : null)
  );
  (mockPrisma.guardian.findUnique as jest.Mock).mockImplementation(
    ({ where }: { where: { parentId_childId: { parentId: string; childId: string } } }) =>
      Promise.resolve(
        guardianOf[where.parentId_childId.parentId] === where.parentId_childId.childId ? { id: 'g-1' } : null
      )
  );
  (mockPrisma.guardian.findFirst as jest.Mock).mockImplementation(({ where }: { where: { parentId: string } }) =>
    Promise.resolve(guardianOf[where.parentId] ? { id: 'g-1' } : null)
  );
}

/**
 * `teamStaff.findMany` answers two questions: the caller's own role rows
 * (getTeamPermissions, `where.userId` set) and the staff list (no userId).
 */
function givenStaffRows(coaches: string[]): void {
  const coachRow = {
    id: 'staff-1',
    teamId: TEAM_ID,
    userId: COACH.id,
    roleId: 'role-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    user: { ...COACH, isManaged: false, deletedAt: null, profilePictureUrl: null },
    role: { id: 'role-1', teamId: TEAM_ID, type: 'HEAD_COACH', name: 'Head Coach', ...ALL_FLAGS },
  };
  (mockPrisma.teamStaff.findMany as jest.Mock).mockImplementation(
    (args: { where: { userId?: string }; include?: Spec }) => {
      if (args.where.userId !== undefined) {
        return Promise.resolve(coaches.includes(args.where.userId) ? [coachRow] : []);
      }
      return Promise.resolve([args.include ? include(coachRow, args.include) : coachRow]);
    }
  );
}

describe('Emails in payloads (#654 #661 #679 #683)', () => {
  afterAll((done) => {
    if (httpServer) {
      httpServer.close(() => done());
    } else {
      done();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    callerId = PLAYER.id;
  });

  describe('announcements carry no author email (#654)', () => {
    const storedAnnouncement: Row = {
      id: ANNOUNCEMENT_ID,
      teamId: TEAM_ID,
      authorId: COACH.id,
      title: 'Practice moved',
      body: 'Five o\'clock.',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      author: { ...COACH, deletedAt: null, profilePictureUrl: null },
      _count: { replies: 0 },
    };

    beforeEach(() => {
      givenTeamStanding({ coach: [COACH.id], member: [PLAYER.id] });
      givenStaffRows([COACH.id]);
      (mockPrisma.announcement.findUnique as jest.Mock).mockImplementation((args: Spec) =>
        Promise.resolve(include(storedAnnouncement, args.include as Spec))
      );
      (mockPrisma.announcement.findMany as jest.Mock).mockImplementation((args: Spec) =>
        Promise.resolve([include(storedAnnouncement, args.include as Spec)])
      );
      (mockPrisma.announcement.count as jest.Mock).mockResolvedValue(1);
    });

    it('GET /teams/:teamId/announcements gives a rostered player the author without an email', async () => {
      const response = await request(app).get(`/api/v1/teams/${TEAM_ID}/announcements`);

      expect(response.status).toBe(200);
      expect(response.body.announcements).toHaveLength(1);
      expect(response.body.announcements[0].author).toEqual({ id: COACH.id, name: COACH.name, deletedAt: null });
    });

    it('GET /announcements/:id gives a rostered player the author without an email', async () => {
      const response = await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.announcement.author).toEqual({ id: COACH.id, name: COACH.name, deletedAt: null });
    });

    it('a coach does not get the author email either: nothing reads it', async () => {
      callerId = COACH.id;

      const response = await request(app).get(`/api/v1/announcements/${ANNOUNCEMENT_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.announcement.author).not.toHaveProperty('email');
    });
  });

  describe('POST /games/:gameId/rsvp applies the GET /rsvps projection (#661)', () => {
    function givenGame(): void {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        id: GAME_ID,
        teamId: TEAM_ID,
        opponent: 'Rivals',
        date: new Date('2026-10-10T18:00:00Z'),
        team: { name: 'Hoops' },
      });
      (mockPrisma.gameRsvp.upsert as jest.Mock).mockImplementation(
        (args: { create: { userId: string; status: string }; include: Spec }) => {
          const user = [COACH, PLAYER, PARENT, CHILD].find((u) => u.id === args.create.userId);
          return Promise.resolve(
            include(
              {
                id: 'rsvp-1',
                gameId: GAME_ID,
                userId: args.create.userId,
                status: args.create.status,
                createdAt: new Date('2026-10-01T00:00:00Z'),
                updatedAt: new Date('2026-10-01T00:00:00Z'),
                user: { ...user, profilePictureUrl: null, deletedAt: null },
              },
              args.include
            )
          );
        }
      );
    }

    it('a guardian RSVPing for a child gets the child without an email', async () => {
      callerId = PARENT.id;
      givenTeamStanding({ coach: [COACH.id], member: [CHILD.id], guardianOf: { [PARENT.id]: CHILD.id } });
      givenStaffRows([COACH.id]);
      givenGame();

      const response = await request(app)
        .post(`/api/v1/games/${GAME_ID}/rsvp`)
        .send({ status: 'YES', playerId: CHILD.id });

      expect(response.status).toBe(200);
      expect(response.body.rsvp.userId).toBe(CHILD.id);
      expect(response.body.rsvp.user).toEqual({ id: CHILD.id, name: CHILD.name });
    });

    it('a guardian who is also the head coach keeps the child\'s email (roster manager)', async () => {
      callerId = COACH.id;
      givenTeamStanding({ coach: [COACH.id], member: [CHILD.id], guardianOf: { [COACH.id]: CHILD.id } });
      givenStaffRows([COACH.id]);
      givenGame();

      const response = await request(app)
        .post(`/api/v1/games/${GAME_ID}/rsvp`)
        .send({ status: 'YES', playerId: CHILD.id });

      expect(response.status).toBe(200);
      expect(response.body.rsvp.user).toEqual({ id: CHILD.id, name: CHILD.name, email: CHILD.email });
    });

    it('a self RSVP still returns the caller\'s own email', async () => {
      givenTeamStanding({ coach: [COACH.id], member: [PLAYER.id] });
      givenStaffRows([COACH.id]);
      givenGame();

      const response = await request(app).post(`/api/v1/games/${GAME_ID}/rsvp`).send({ status: 'NO' });

      expect(response.status).toBe(200);
      expect(response.body.rsvp.user).toEqual({ id: PLAYER.id, name: PLAYER.name, email: PLAYER.email });
    });
  });

  describe('GET /invitations/:id applies the roster-email rule to player.email (#679)', () => {
    beforeEach(() => {
      (mockPrisma.teamInvitation.findUnique as jest.Mock).mockImplementation((args: Spec) =>
        Promise.resolve(
          shape(
            {
              id: INVITATION_ID,
              teamId: TEAM_ID,
              playerId: PLAYER.id,
              invitedById: COACH.id,
              status: 'PENDING',
              token: 'bearer-secret',
              jerseyNumber: 0,
              position: null,
              message: null,
              expiresAt: new Date('2026-10-20T00:00:00Z'),
              createdAt: new Date('2026-10-01T00:00:00Z'),
              updatedAt: new Date('2026-10-01T00:00:00Z'),
              acceptedAt: null,
              rejectedAt: null,
              team: { id: TEAM_ID, name: 'Hoops', season: { id: 's-1', name: '2026', league: { id: 'l-1', name: 'League' } } },
              player: { ...PLAYER, deletedAt: null },
              invitedBy: { ...COACH, deletedAt: null },
            },
            args
          )
        )
      );
    });

    it('a rostered teammate without a staff role gets player { id, name } and the coach\'s email', async () => {
      callerId = TEAMMATE.id;
      givenTeamStanding({ coach: [COACH.id], member: [TEAMMATE.id] });
      givenStaffRows([COACH.id]);

      const response = await request(app).get(`/api/v1/invitations/${INVITATION_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.invitation.player).toEqual({ id: PLAYER.id, name: PLAYER.name });
      expect(response.body.invitation.invitedBy.email).toBe(COACH.email);
      expect(response.body.invitation).not.toHaveProperty('token');
    });

    it('the head coach (roster manager) gets player.email', async () => {
      callerId = COACH.id;
      givenTeamStanding({ coach: [COACH.id] });
      givenStaffRows([COACH.id]);

      const response = await request(app).get(`/api/v1/invitations/${INVITATION_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.invitation.player).toEqual({ id: PLAYER.id, name: PLAYER.name, email: PLAYER.email });
      expect(response.body.invitation).not.toHaveProperty('token');
    });

    it('the invited player gets their own email', async () => {
      givenTeamStanding({ coach: [COACH.id] });
      givenStaffRows([COACH.id]);

      const response = await request(app).get(`/api/v1/invitations/${INVITATION_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.invitation.player.email).toBe(PLAYER.email);
    });
  });

  describe('GET /teams/:teamId/staff returns staff emails to every team member (#683)', () => {
    it('a rostered player gets the coach\'s email', async () => {
      givenTeamStanding({ coach: [COACH.id], member: [PLAYER.id] });
      givenStaffRows([COACH.id]);

      const response = await request(app).get(`/api/v1/teams/${TEAM_ID}/staff`);

      expect(response.status).toBe(200);
      expect(response.body.staff).toHaveLength(1);
      expect(response.body.staff[0].user).toEqual(
        expect.objectContaining({ id: COACH.id, name: COACH.name, email: COACH.email })
      );
    });

    it('a guardian of a rostered player gets the coach\'s email', async () => {
      callerId = PARENT.id;
      givenTeamStanding({ coach: [COACH.id], member: [CHILD.id], guardianOf: { [PARENT.id]: CHILD.id } });
      givenStaffRows([COACH.id]);

      const response = await request(app).get(`/api/v1/teams/${TEAM_ID}/staff`);

      expect(response.status).toBe(200);
      expect(response.body.staff[0].user.email).toBe(COACH.email);
    });
  });
});
