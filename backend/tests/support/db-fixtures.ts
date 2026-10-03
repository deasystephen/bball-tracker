/**
 * Fixture builder for the real-database suites (`tests/integration/*.db.test.ts`, #458).
 *
 * Every row it creates carries the suite's run id in the place
 * `tests/support/test-leftovers.ts` looks for it (user email
 * `<key>.<run>@example.test`, league `ZZ-<label>-<key>-<run>`, team
 * `<key>-<run>`), so `cleanup()` removes the whole run by pattern and a test
 * that throws half-way still leaves nothing behind (#584).
 *
 * The client is passed in rather than imported: `tests/setup.ts` mocks
 * `src/models` globally, and only a suite that has called
 * `jest.unmock('../../src/models')` holds a real one.
 */

import { randomUUID } from 'node:crypto';
import type { GameStatus, PrismaClient, TeamRoleType, UserRole } from '@prisma/client';
import { removeTestRows, TEST_EMAIL_DOMAIN } from './test-leftovers';

/** One league, one active season, one team and one staff role in it. */
export interface Org {
  leagueId: string;
  leagueName: string;
  seasonId: string;
  teamId: string;
  teamName: string;
  /** The role `staff()` attaches; `HEAD_COACH` with every flag unless `org()` is told otherwise. */
  roleId: string;
}

export interface OrgOptions {
  /** Put the team in an existing league and season instead of creating new ones. */
  league?: Pick<Org, 'leagueId' | 'leagueName' | 'seasonId'>;
  roleType?: TeamRoleType;
  roleFlags?: Partial<
    Record<'canManageTeam' | 'canManageRoster' | 'canTrackStats' | 'canViewStats' | 'canShareStats', boolean>
  >;
}

const ALL_FLAGS = {
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
} as const;

export class DbFixtures {
  /** Eight hex characters; every row name ends in it. */
  readonly run = randomUUID().slice(0, 8);
  /** Users by the key they were created with. */
  readonly users: Record<string, string> = {};
  /** Orgs by the key they were created with. */
  readonly orgs: Record<string, Org> = {};

  /**
   * @param label Distinguishes this suite's leagues from another suite's in a
   *   shared local database (`ZZ-<label>-…`).
   */
  constructor(
    private readonly db: PrismaClient,
    private readonly label: string
  ) {}

  /**
   * Fails with something actionable rather than a raw Prisma error when there
   * is no database. Never skips: a silently skipped authorization test is
   * worse than none.
   */
  async requireDatabase(): Promise<void> {
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        'This suite needs a real Postgres. Start one and apply migrations:\n' +
          '  docker-compose up -d && cd backend && npx prisma migrate deploy\n' +
          `DATABASE_URL=${process.env.DATABASE_URL ?? '(unset)'}`,
        { cause: err }
      );
    }
  }

  async user(key: string, role: UserRole): Promise<string> {
    const user = await this.db.user.create({
      data: { name: `${key}-${this.run}`, email: `${key}.${this.run}@${TEST_EMAIL_DOMAIN}`, role },
      select: { id: true },
    });
    this.users[key] = user.id;
    return user.id;
  }

  async org(key: string, options: OrgOptions = {}): Promise<Org> {
    let league = options.league;
    if (!league) {
      const leagueName = `ZZ-${this.label}-${key}-${this.run}`;
      const created = await this.db.league.create({ data: { name: leagueName }, select: { id: true } });
      const season = await this.db.season.create({
        data: { leagueId: created.id, name: `S-${this.run}`, isActive: true },
        select: { id: true },
      });
      league = { leagueId: created.id, leagueName, seasonId: season.id };
    }
    const teamName = `${key}-${this.run}`;
    const team = await this.db.team.create({
      data: { name: teamName, season: { connect: { id: league.seasonId } }, lineage: { create: {} } },
      select: { id: true },
    });
    const role = await this.db.teamRole.create({
      data: {
        teamId: team.id,
        type: options.roleType ?? 'HEAD_COACH',
        name: options.roleType ?? 'HEAD_COACH',
        ...ALL_FLAGS,
        ...options.roleFlags,
      },
      select: { id: true },
    });
    const org: Org = { ...league, teamId: team.id, teamName, roleId: role.id };
    this.orgs[key] = org;
    return org;
  }

  /** The auto-provisioned container a coach gets; owner is the only link. */
  async personalLeague(key: string, ownerId: string): Promise<string> {
    const league = await this.db.league.create({
      data: { name: `ZZ-${this.label}-${key}-${this.run}`, personalOwnerId: ownerId },
      select: { id: true },
    });
    return league.id;
  }

  async staff(userId: string, org: Org, roleId: string = org.roleId): Promise<void> {
    await this.db.teamStaff.create({ data: { teamId: org.teamId, userId, roleId } });
  }

  async member(playerId: string, org: Org): Promise<void> {
    await this.db.teamMember.create({ data: { teamId: org.teamId, playerId } });
  }

  async leagueAdmin(userId: string, org: Pick<Org, 'leagueId'>): Promise<void> {
    await this.db.leagueAdmin.create({ data: { leagueId: org.leagueId, userId } });
  }

  async guardian(parentId: string, childId: string): Promise<void> {
    await this.db.guardian.create({
      data: { parentId, childId, relationship: 'GUARDIAN', isPrimary: true },
    });
  }

  async game(
    org: Org,
    data: { opponent?: string; date?: Date; status?: GameStatus } = {}
  ): Promise<string> {
    const game = await this.db.game.create({
      data: {
        teamId: org.teamId,
        opponent: data.opponent ?? `Opp-${this.run}`,
        date: data.date ?? new Date(),
        status: data.status ?? 'SCHEDULED',
      },
      select: { id: true },
    });
    return game.id;
  }

  /**
   * Removes every row of this run by pattern, plus the users created here by
   * id (for rows that lost their run id on the way, such as a deleted account
   * that became a tombstone). Does not disconnect: the suite owns the client.
   */
  async cleanup(): Promise<void> {
    await removeTestRows(this.db, { run: this.run, alsoUserIds: Object.values(this.users) });
  }
}
