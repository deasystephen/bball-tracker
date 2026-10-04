/**
 * Seed script - creates test data for development
 * Run with: npm run db:seed
 */

import { PrismaClient, UserRole, GuardianRelationship, SubscriptionTier } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { createDefaultTeamRoles } from '../src/utils/permissions';
import { removeTestRows } from '../tests/support/test-leftovers';
import { FLOW_CREATED_OPPONENTS, FLOW_CREATED_ANNOUNCEMENT_TITLES } from '../tests/support/flow-fixtures';
import {
  BRYCE_JAMES_ID,
  LAKERS_MANAGED_IDS,
  SEED_IDS,
  SEEDED_LAKERS_MANAGED_IDS,
  lakersVsSunsEvents,
  seededGames,
  warriorsVsHeatEvents,
} from '../tests/support/seed-fixtures';
import { removeTombstones, restoreSeededGames, writeFinishedGameEvents } from '../tests/support/seed-resets';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/**
 * The team's three default roles, created by the same function
 * `TeamService.createTeam` uses (#787), so the seeded Warriors and Lakers carry
 * exactly the flags a team created through the API gets. Only on a team that
 * has no roles yet: the service function has no `skipDuplicates`, and the
 * seeded TeamStaff rows point at the existing roles.
 */
async function ensureDefaultTeamRoles(teamId: string): Promise<void> {
  if ((await prisma.teamRole.count({ where: { teamId } })) === 0) {
    await createDefaultTeamRoles(teamId, prisma);
  }
}

async function main() {
  // Seed data includes live bearer secrets (invitation tokens honored by the
  // UNAUTHENTICATED /invitations/by-token routes in every environment), so
  // never run against production (pre-landing review, security specialist).
  // The realistic accident is not NODE_ENV=production — it is a local shell
  // (NODE_ENV unset) with DATABASE_URL repointed at prod, exactly how the RDS
  // runbook connects during a restore. Guard both signals (red-team review).
  const looksLikeProdDb = /rds\.amazonaws\.com/i.test(process.env.DATABASE_URL ?? '');
  if (
    (process.env.NODE_ENV === 'production' || looksLikeProdDb) &&
    process.env.SEED_ALLOW_PRODUCTION !== 'true'
  ) {
    throw new Error(
      'Refusing to seed: NODE_ENV=production or DATABASE_URL points at an RDS host. ' +
        'Set SEED_ALLOW_PRODUCTION=true only if you really mean it.'
    );
  }

  console.log('Seeding database...\n');

  // Account-deletion tombstones (#444) left by .maestro/account-delete.yaml and
  // .maestro/guardian-child-delete.yaml. The fixtures are recreated below by
  // email / fixed id, so the old rows would otherwise pile up as "Deleted user"
  // in the dev-login list. The hazard in a hard delete is not game events
  // (GameEvent.playerId is SET NULL) but the invitations a tombstone SENT:
  // `invitedById` is ON DELETE RESTRICT on both invitation tables and account
  // deletion keeps those rows, so removeTombstones deletes them first, in one
  // transaction (#783). Runs first, so no upsert below can meet a tombstone.
  const staleTombstones = await removeTombstones(prisma);
  if (staleTombstones.users > 0) {
    console.log(
      `  Removed ${staleTombstones.users} account-deletion tombstone(s) and ` +
        `${staleTombstones.invitations} invitation(s) they sent from a previous E2E run`
    );
  }

  // Rows that tests/integration/*.db.test.ts left behind when a run was
  // interrupted (#584). They carry `@example.test` addresses and names with a
  // run id; no seeded fixture does. 26 of them once filled the dev-login list.
  const leftovers = await removeTestRows(prisma, 'all');
  if (leftovers.users + leftovers.leagues + leftovers.teams > 0) {
    console.log(
      `  Removed what interrupted test runs left behind: ${leftovers.users} account(s), ` +
        `${leftovers.leagues} league(s), ${leftovers.teams} team(s), ${leftovers.games} game(s), ` +
        `${leftovers.invitations} invitation(s)`
    );
  }

  // =========================================================================
  // USERS
  // =========================================================================
  console.log('Creating users...');

  // System Admin
  const admin = await prisma.user.upsert({
    where: { email: 'admin@bball-tracker.com' },
    update: {},
    create: {
      email: 'admin@bball-tracker.com',
      name: 'System Admin',
      role: UserRole.ADMIN,
      emailVerified: true,
    },
  });
  console.log(`  Created admin: ${admin.email}`);

  // Coaches
  const coachSteve = await prisma.user.upsert({
    where: { email: 'steve.kerr@example.com' },
    update: {
      subscriptionTier: SubscriptionTier.PREMIUM,
      subscriptionExpiresAt: new Date('2027-12-31'),
    },
    create: {
      email: 'steve.kerr@example.com',
      name: 'Steve Kerr',
      role: UserRole.COACH,
      emailVerified: true,
      subscriptionTier: SubscriptionTier.PREMIUM,
      subscriptionExpiresAt: new Date('2027-12-31'),
    },
  });
  console.log(`  Created coach: ${coachSteve.email}`);

  const coachFrank = await prisma.user.upsert({
    where: { email: 'frank.vogel@example.com' },
    // Reset the name: profile.yaml renames him mid-flow and reverts at the
    // end, but a run that dies between the two leaves "Frank Renamed" behind
    // — and every other flow selects him by the seeded name.
    update: { name: 'Frank Vogel' },
    create: {
      email: 'frank.vogel@example.com',
      name: 'Frank Vogel',
      role: UserRole.COACH,
      emailVerified: true,
    },
  });
  console.log(`  Created coach: ${coachFrank.email}`);

  // Reset the fixture: `.maestro/create-team.yaml` creates a "Test Team" for
  // Frank on every run and nothing else deletes it, so without this reset
  // the leftovers accumulate, one more identically named team per run. (While
  // FREE was capped at 3 teams they also turned the flow's create step into a
  // 402 after two runs — found live while diagnosing #464; no tier is capped
  // since #445.) Same idempotence rule as Dana's block below: everything but
  // his seeded Lakers goes. Team deletes cascade to members/staff/roles.
  const staleFrankTeams = await prisma.team.findMany({
    where: {
      staff: { some: { userId: coachFrank.id } },
      id: { not: SEED_IDS.LAKERS_TEAM },
    },
    select: { id: true },
  });
  if (staleFrankTeams.length > 0) {
    await prisma.team.deleteMany({ where: { id: { in: staleFrankTeams.map((t) => t.id) } } });
    console.log(`    Removed ${staleFrankTeams.length} team(s) left over from a previous E2E run`);
  }

  // ...and the games the game flows create on his Lakers ("Test Rival" from
  // game-lifecycle.yaml, "Tracking Rival" from game-tracking.yaml, "Spectator
  // Rival" from live-spectator.yaml). They accumulate one per run, pollute the
  // Games tab and push seeded games (e.g. guardian-rsvp.yaml's "vs Lakers")
  // down the list until assertions time out. "Spectator Rival" was missing
  // here until #584, and each of its games stays IN_PROGRESS, so the Games tab
  // had filled with live games. Game deletes cascade to events/RSVPs/stats rows.
  // A flow that creates a game must add its opponent name to this list.
  const staleFixtureGames = await prisma.game.deleteMany({
    where: { opponent: { in: FLOW_CREATED_OPPONENTS } },
  });
  if (staleFixtureGames.count > 0) {
    console.log(`    Removed ${staleFixtureGames.count} fixture game(s) from a previous E2E run`);
  }

  // ...and the announcement announcement-reply.yaml posts (its replies go
  // with it: AnnouncementReply cascades from Announcement, #34).
  const staleFixtureAnnouncements = await prisma.announcement.deleteMany({
    where: { title: { in: FLOW_CREATED_ANNOUNCEMENT_TITLES } },
  });
  if (staleFixtureAnnouncements.count > 0) {
    console.log(`    Removed ${staleFixtureAnnouncements.count} fixture announcement(s) from a previous E2E run`);
  }

  // ...and the managed players roster flows add to his Lakers (E2E Test
  // Player from roster-management.yaml). Guarded to flow-created rows: the
  // SEEDED Lakers managed players are the fixed UUIDs in
  // SEEDED_LAKERS_MANAGED_IDS (tests/support/seed-fixtures.ts) and are upserted
  // below; never widen this to all of Frank's managed players (#782: a dead
  // prefix guard hard-deleted all six fixtures on every reseed, cascading
  // their stats and RSVPs on games the seed does not rebuild).
  const staleFrankManaged = await prisma.user.deleteMany({
    where: {
      managedById: coachFrank.id,
      isManaged: true,
      deletedAt: null,
      id: { notIn: [...SEEDED_LAKERS_MANAGED_IDS] },
    },
  });
  if (staleFrankManaged.count > 0) {
    console.log(`    Removed ${staleFrankManaged.count} flow-created managed player(s) from a previous E2E run`);
  }

  const assistantMike = await prisma.user.upsert({
    where: { email: 'mike.brown@example.com' },
    update: {},
    create: {
      email: 'mike.brown@example.com',
      name: 'Mike Brown',
      role: UserRole.COACH,
      emailVerified: true,
    },
  });
  console.log(`  Created assistant coach: ${assistantMike.email}`);

  // Brand-new-signup fixture (#442, .maestro/coach-onboarding.yaml).
  // Deliberately has NO TeamStaff row, NO TeamMember row and NO LeagueAdmin
  // row — every other seeded coach is already rostered on a team and admin@
  // is a league admin, so before this there was no fixture for the funnel the
  // GA blocker is measured by. Do not add her to a team, a league or a season:
  // that is the whole point of the fixture.
  //
  // Seeded PLAYER, not COACH, on purpose. Every WorkOS sign-up is created as
  // PLAYER and #442's acceptance criterion is "signs up, PICKS Coach, and taps
  // Create Team". A COACH-seeded fixture would skip `onboarding/role`
  // entirely (`needsRoleChoice` is false for a non-PLAYER) and the flow would
  // silently stop testing the first step of the journey.
  const coachDana = await prisma.user.upsert({
    where: { email: 'dana.whitfield@example.com' },
    update: { role: UserRole.PLAYER },
    create: {
      email: 'dana.whitfield@example.com',
      name: 'Dana Whitfield',
      role: UserRole.PLAYER,
      emailVerified: true,
    },
  });
  console.log(`  Created unaffiliated new signup: ${coachDana.email}`);

  // Reset the fixture: delete any teams a previous E2E run created for her.
  // Without this a re-seed would not restore the "brand-new coach" state that
  // coach-onboarding.yaml starts from. Team deletes cascade
  // to members / staff / roles; her auto-provisioned personal league (if the
  // #442 backend has run) is left in place — reusing it is the second-team
  // branch the flow exercises.
  const staleFixtureTeams = await prisma.team.findMany({
    where: { staff: { some: { userId: coachDana.id } } },
    select: { id: true },
  });
  if (staleFixtureTeams.length > 0) {
    await prisma.team.deleteMany({ where: { id: { in: staleFixtureTeams.map((t) => t.id) } } });
    console.log(`    Removed ${staleFixtureTeams.length} team(s) left over from a previous E2E run`);
  }

  // Also drop her auto-provisioned personal league (#442), so a re-seed
  // restores a genuinely brand-new coach and the flow exercises
  // provision-then-reuse rather than reuse-then-reuse. Cascades to its seasons
  // and any teams inside it. Together with `role: PLAYER` above this makes the
  // fixture fully idempotent: `npx prisma db seed` is the reset, and the E2E
  // flow can assert the role step HARD instead of tolerating its absence.
  const stalePersonalLeagues = await prisma.league.deleteMany({
    where: { personalOwnerId: coachDana.id },
  });
  if (stalePersonalLeagues.count > 0) {
    console.log(`    Removed ${stalePersonalLeagues.count} personal league(s) from a previous run`);
  }

  // ...and the managed players she rostered. Deleting her teams cascades the
  // TeamMember rows but leaves the managed User behind, so without this the
  // dev-login list grows by one account per E2E run. That is not cosmetic: it
  // pushes Dana further down the list until `scrollUntilVisible` times out and
  // the flow fails somewhere unrelated to what it tests.
  const staleManagedPlayers = await prisma.user.deleteMany({
    where: { managedById: coachDana.id, isManaged: true },
  });
  if (staleManagedPlayers.count > 0) {
    console.log(`    Removed ${staleManagedPlayers.count} managed player(s) from a previous run`);
  }

  // Players
  const playerData = [
    { email: 'steph.curry@example.com', name: 'Steph Curry' },
    { email: 'klay.thompson@example.com', name: 'Klay Thompson' },
    { email: 'draymond.green@example.com', name: 'Draymond Green' },
    { email: 'andrew.wiggins@example.com', name: 'Andrew Wiggins' },
    { email: 'jordan.poole@example.com', name: 'Jordan Poole' },
    { email: 'lebron.james@example.com', name: 'LeBron James' },
    { email: 'anthony.davis@example.com', name: 'Anthony Davis' },
    { email: 'russell.westbrook@example.com', name: 'Russell Westbrook' },
    { email: 'austin.reaves@example.com', name: 'Austin Reaves' },
    { email: 'dangelo.russell@example.com', name: "D'Angelo Russell" },
  ];

  const players: Record<string, typeof coachSteve> = {};
  for (const data of playerData) {
    const player = await prisma.user.upsert({
      where: { email: data.email },
      // Reset role and name: onboarding-role.yaml flips Steph Curry to COACH
      // and back via "Change account type" — a run that dies between the two
      // leaves him COACH, which suppresses the role screen this flow asserts
      // and un-gates the tracking controls player-no-tracking.yaml asserts
      // absent. Same idempotence rule as Frank's name.
      update: { role: UserRole.PLAYER, name: data.name },
      create: {
        email: data.email,
        name: data.name,
        role: UserRole.PLAYER,
        emailVerified: true,
      },
    });
    players[data.email] = player;
    console.log(`  Created player: ${player.email}`);
  }

  // Parents
  const parentDell = await prisma.user.upsert({
    where: { email: 'dell.curry@example.com' },
    update: {},
    create: {
      email: 'dell.curry@example.com',
      name: 'Dell Curry',
      role: UserRole.PARENT,
      emailVerified: true,
    },
  });
  console.log(`  Created parent: ${parentDell.email}`);

  const parentSonya = await prisma.user.upsert({
    where: { email: 'sonya.curry@example.com' },
    update: {},
    create: {
      email: 'sonya.curry@example.com',
      name: 'Sonya Curry',
      role: UserRole.PARENT,
      emailVerified: true,
    },
  });
  console.log(`  Created parent: ${parentSonya.email}`);

  const parentGloria = await prisma.user.upsert({
    where: { email: 'gloria.james@example.com' },
    update: {},
    create: {
      email: 'gloria.james@example.com',
      name: 'Gloria James',
      role: UserRole.PARENT,
      emailVerified: true,
    },
  });
  console.log(`  Created parent: ${parentGloria.email}`);

  // =========================================================================
  // GUARDIAN RELATIONSHIPS
  // =========================================================================
  console.log('\nCreating guardian relationships...');

  await prisma.guardian.upsert({
    where: { parentId_childId: { parentId: parentDell.id, childId: players['steph.curry@example.com'].id } },
    update: {},
    create: {
      parentId: parentDell.id,
      childId: players['steph.curry@example.com'].id,
      relationship: GuardianRelationship.FATHER,
      isPrimary: true,
    },
  });
  console.log(`  Dell Curry -> Steph Curry (Father)`);

  await prisma.guardian.upsert({
    where: { parentId_childId: { parentId: parentSonya.id, childId: players['steph.curry@example.com'].id } },
    update: {},
    create: {
      parentId: parentSonya.id,
      childId: players['steph.curry@example.com'].id,
      relationship: GuardianRelationship.MOTHER,
      isPrimary: false,
    },
  });
  console.log(`  Sonya Curry -> Steph Curry (Mother)`);

  await prisma.guardian.upsert({
    where: { parentId_childId: { parentId: parentGloria.id, childId: players['lebron.james@example.com'].id } },
    update: {},
    create: {
      parentId: parentGloria.id,
      childId: players['lebron.james@example.com'].id,
      relationship: GuardianRelationship.MOTHER,
      isPrimary: true,
    },
  });
  console.log(`  Gloria James -> LeBron James (Mother)`);

  // Guardian child-deletion fixture (#444, .maestro/guardian-child-delete.yaml):
  // a MANAGED, unclaimed Lakers player with Gloria as guardian. Fixed real UUID
  // because every /players/:id route validates the param (a `managed-…` id
  // would 400 on the very call the flow tests). The flow deletes him; the
  // tombstone sweep at the top removes the old row and this recreates him.
  const bryce = await prisma.user.upsert({
    where: { id: BRYCE_JAMES_ID },
    update: {},
    create: {
      id: BRYCE_JAMES_ID,
      name: 'Bryce James',
      role: UserRole.PLAYER,
      isManaged: true,
      managedById: coachFrank.id,
      email: null,
    },
  });
  await prisma.guardian.upsert({
    where: { parentId_childId: { parentId: parentGloria.id, childId: bryce.id } },
    update: {},
    create: {
      parentId: parentGloria.id,
      childId: bryce.id,
      relationship: GuardianRelationship.MOTHER,
      isPrimary: true,
    },
  });
  console.log(`  Gloria James -> Bryce James (Mother, managed child)`);

  // =========================================================================
  // LEAGUE & SEASON
  // =========================================================================
  console.log('\nCreating league and season...');

  const league = await prisma.league.upsert({
    where: { id: SEED_IDS.LEAGUE },
    update: {},
    create: {
      id: SEED_IDS.LEAGUE,
      name: 'Downtown Youth Basketball League',
    },
  });
  console.log(`  Created league: ${league.name}`);

  // Add admin as league admin
  await prisma.leagueAdmin.upsert({
    where: { leagueId_userId: { leagueId: league.id, userId: admin.id } },
    update: {},
    create: {
      leagueId: league.id,
      userId: admin.id,
    },
  });
  console.log(`  Added ${admin.name} as league admin`);

  const season = await prisma.season.upsert({
    where: { leagueId_name: { leagueId: league.id, name: 'Spring 2024' } },
    update: {},
    create: {
      leagueId: league.id,
      name: 'Spring 2024',
      startDate: new Date('2024-03-01'),
      endDate: new Date('2024-06-30'),
      isActive: true,
    },
  });
  console.log(`  Created season: ${season.name}`);

  // Reset the fixture: `.maestro/admin-season-manage.yaml` creates an
  // "E2E Season…" in this league and deletes it at the end, so only an
  // interrupted run leaves one behind — and the next run would then fail on
  // the duplicate name. Only team-less seasons go (the flow never adds a team).
  const staleFlowSeasons = await prisma.season.deleteMany({
    where: { leagueId: league.id, name: { startsWith: 'E2E Season' }, teams: { none: {} } },
  });
  if (staleFlowSeasons.count > 0) {
    console.log(`    Removed ${staleFlowSeasons.count} season(s) left over from a previous E2E run`);
  }
  // ...and the throwaway "E2E League" the same flow creates and deletes at its
  // end. Only a league with no teams anywhere goes (cascades to its seasons).
  const staleFlowLeagues = await prisma.league.deleteMany({
    where: { name: 'E2E League', personalOwnerId: null, seasons: { every: { teams: { none: {} } } } },
  });
  if (staleFlowLeagues.count > 0) {
    console.log(`    Removed ${staleFlowLeagues.count} league(s) left over from a previous E2E run`);
  }

  // =========================================================================
  // TEAMS
  // =========================================================================
  console.log('\nCreating teams...');

  // Warriors
  await prisma.teamLineage.upsert({
    where: { id: SEED_IDS.WARRIORS_LINEAGE },
    update: {},
    create: { id: SEED_IDS.WARRIORS_LINEAGE },
  });
  const warriors = await prisma.team.upsert({
    where: { id: SEED_IDS.WARRIORS_TEAM },
    update: { lineageId: SEED_IDS.WARRIORS_LINEAGE },
    create: {
      id: SEED_IDS.WARRIORS_TEAM,
      name: 'Warriors',
      seasonId: season.id,
      lineageId: SEED_IDS.WARRIORS_LINEAGE,
      ageGroup: 'U14',
      gender: 'BOYS',
      chatLink: 'https://chat.whatsapp.com/warriors-team-chat',
    },
  });
  console.log(`  Created team: ${warriors.name}`);

  // Create default roles for Warriors
  await ensureDefaultTeamRoles(warriors.id);
  console.log(`    Created default roles for ${warriors.name}`);

  // Get the head coach and assistant coach roles
  const warriorsHeadCoachRole = await prisma.teamRole.findUnique({
    where: { teamId_name: { teamId: warriors.id, name: 'Head Coach' } },
  });
  const warriorsAssistantCoachRole = await prisma.teamRole.findUnique({
    where: { teamId_name: { teamId: warriors.id, name: 'Assistant Coach' } },
  });
  const warriorsTeamManagerRole = await prisma.teamRole.findUnique({
    where: { teamId_name: { teamId: warriors.id, name: 'Team Manager' } },
  });

  // Assign coaches to Warriors
  if (warriorsHeadCoachRole) {
    await prisma.teamStaff.upsert({
      where: { teamId_userId_roleId: { teamId: warriors.id, userId: coachSteve.id, roleId: warriorsHeadCoachRole.id } },
      update: {},
      create: {
        teamId: warriors.id,
        userId: coachSteve.id,
        roleId: warriorsHeadCoachRole.id,
      },
    });
    console.log(`    Assigned ${coachSteve.name} as Head Coach`);
  }

  if (warriorsAssistantCoachRole) {
    await prisma.teamStaff.upsert({
      where: { teamId_userId_roleId: { teamId: warriors.id, userId: assistantMike.id, roleId: warriorsAssistantCoachRole.id } },
      update: {},
      create: {
        teamId: warriors.id,
        userId: assistantMike.id,
        roleId: warriorsAssistantCoachRole.id,
      },
    });
    console.log(`    Assigned ${assistantMike.name} as Assistant Coach`);
  }

  // Assign Dell Curry as Team Manager (parent volunteer)
  if (warriorsTeamManagerRole) {
    await prisma.teamStaff.upsert({
      where: { teamId_userId_roleId: { teamId: warriors.id, userId: parentDell.id, roleId: warriorsTeamManagerRole.id } },
      update: {},
      create: {
        teamId: warriors.id,
        userId: parentDell.id,
        roleId: warriorsTeamManagerRole.id,
      },
    });
    console.log(`    Assigned ${parentDell.name} as Team Manager (parent volunteer)`);
  }

  // Warriors players
  const warriorsPlayers = [
    { email: 'steph.curry@example.com', jersey: 30, position: 'PG' },
    { email: 'klay.thompson@example.com', jersey: 11, position: 'SG' },
    { email: 'draymond.green@example.com', jersey: 23, position: 'PF' },
    { email: 'andrew.wiggins@example.com', jersey: 22, position: 'SF' },
    { email: 'jordan.poole@example.com', jersey: 3, position: 'SG' },
  ];

  for (const p of warriorsPlayers) {
    await prisma.teamMember.upsert({
      where: { teamId_playerId: { teamId: warriors.id, playerId: players[p.email].id } },
      update: {},
      create: {
        teamId: warriors.id,
        playerId: players[p.email].id,
        jerseyNumber: p.jersey,
        position: p.position,
      },
    });
    console.log(`    Added player: ${players[p.email].name} (#${p.jersey})`);
  }

  // Lakers (no age group / gender on purpose: the empty-field path)
  await prisma.teamLineage.upsert({
    where: { id: SEED_IDS.LAKERS_LINEAGE },
    update: {},
    create: { id: SEED_IDS.LAKERS_LINEAGE },
  });
  const lakers = await prisma.team.upsert({
    where: { id: SEED_IDS.LAKERS_TEAM },
    update: { lineageId: SEED_IDS.LAKERS_LINEAGE },
    create: {
      id: SEED_IDS.LAKERS_TEAM,
      name: 'Lakers',
      seasonId: season.id,
      lineageId: SEED_IDS.LAKERS_LINEAGE,
    },
  });
  console.log(`  Created team: ${lakers.name}`);

  // Create default roles for Lakers
  await ensureDefaultTeamRoles(lakers.id);
  console.log(`    Created default roles for ${lakers.name}`);

  const lakersHeadCoachRole = await prisma.teamRole.findUnique({
    where: { teamId_name: { teamId: lakers.id, name: 'Head Coach' } },
  });

  if (lakersHeadCoachRole) {
    await prisma.teamStaff.upsert({
      where: { teamId_userId_roleId: { teamId: lakers.id, userId: coachFrank.id, roleId: lakersHeadCoachRole.id } },
      update: {},
      create: {
        teamId: lakers.id,
        userId: coachFrank.id,
        roleId: lakersHeadCoachRole.id,
      },
    });
    console.log(`    Assigned ${coachFrank.name} as Head Coach`);
  }

  // Lakers players
  const lakersPlayers = [
    { email: 'lebron.james@example.com', jersey: 23, position: 'SF' },
    { email: 'anthony.davis@example.com', jersey: 3, position: 'PF' },
    { email: 'russell.westbrook@example.com', jersey: 0, position: 'PG' },
    { email: 'austin.reaves@example.com', jersey: 15, position: 'SG' },
    { email: 'dangelo.russell@example.com', jersey: 1, position: 'PG' },
  ];

  for (const p of lakersPlayers) {
    await prisma.teamMember.upsert({
      where: { teamId_playerId: { teamId: lakers.id, playerId: players[p.email].id } },
      update: {},
      create: {
        teamId: lakers.id,
        playerId: players[p.email].id,
        jerseyNumber: p.jersey,
        position: p.position,
      },
    });
    console.log(`    Added player: ${players[p.email].name} (#${p.jersey})`);
  }

  // =========================================================================
  // MANAGED PLAYERS (COPPA-compliant, no email required)
  // =========================================================================
  console.log('\nCreating managed players...');

  // Managed-player ids must be REAL UUIDs (fixed, like SEED_IDS): the API
  // validates playerId with z.string().uuid(), so the old `managed-lakers-7`
  // style ids made every game event / RSVP for these players 400 — a seed-only
  // bug (production rows get uuid() defaults). Clean up legacy string-id rows
  // so pre-existing dev DBs don't keep duplicates alongside the UUID rows.
  await prisma.user.deleteMany({ where: { id: { startsWith: 'managed-' } } });

  // Warriors managed players (managed by Coach Steve Kerr)
  const managedWarriorsPlayers = [
    { id: '40000000-0000-4000-a000-000000000005', name: 'Tommy Wilson', jersey: 5, position: 'PG' },
    { id: '40000000-0000-4000-a000-000000000012', name: 'Jake Martinez', jersey: 12, position: 'SF' },
    { id: '40000000-0000-4000-a000-000000000008', name: 'Ryan Chen', jersey: 8, position: 'C' },
  ];

  for (const mp of managedWarriorsPlayers) {
    const managedPlayer = await prisma.user.upsert({
      where: { id: mp.id },
      update: {},
      create: {
        id: mp.id,
        name: mp.name,
        role: UserRole.PLAYER,
        isManaged: true,
        managedById: coachSteve.id,
        email: null,
      },
    });

    await prisma.teamMember.upsert({
      where: { teamId_playerId: { teamId: warriors.id, playerId: managedPlayer.id } },
      update: {},
      create: {
        teamId: warriors.id,
        playerId: managedPlayer.id,
        jerseyNumber: mp.jersey,
        position: mp.position,
      },
    });
    console.log(`    Added managed player: ${mp.name} (#${mp.jersey}) to Warriors`);
  }

  // Lakers managed players (managed by Coach Frank Vogel). Bryce James is the
  // #444 guardian child-deletion fixture (created above with Gloria as guardian).
  const managedLakersPlayers = [
    { id: LAKERS_MANAGED_IDS.MARCUS_JOHNSON, name: 'Marcus Johnson', jersey: 7, position: 'SG' },
    { id: LAKERS_MANAGED_IDS.ETHAN_WILLIAMS, name: 'Ethan Williams', jersey: 14, position: 'PF' },
    { id: LAKERS_MANAGED_IDS.BRYCE_JAMES, name: 'Bryce James', jersey: 9, position: 'SG' },
  ];

  for (const mp of managedLakersPlayers) {
    const managedPlayer = await prisma.user.upsert({
      where: { id: mp.id },
      update: {},
      create: {
        id: mp.id,
        name: mp.name,
        role: UserRole.PLAYER,
        isManaged: true,
        managedById: coachFrank.id,
        email: null,
      },
    });

    await prisma.teamMember.upsert({
      where: { teamId_playerId: { teamId: lakers.id, playerId: managedPlayer.id } },
      update: {},
      create: {
        teamId: lakers.id,
        playerId: managedPlayer.id,
        jerseyNumber: mp.jersey,
        position: mp.position,
      },
    });
    console.log(`    Added managed player: ${mp.name} (#${mp.jersey}) to Lakers`);
  }

  // Lakers invite-status fixtures (roster/invite unification spec): one
  // rostered managed player per chip state so Maestro/manual QA can assert
  // Invited / Invite expired / Active-via-web-accept deterministically.
  // (Marcus/Ethan above cover "Not invited"; claimed players cover "Active".)
  const inviteStateFixtures = [
    {
      id: LAKERS_MANAGED_IDS.IRIS_INVITED,
      name: 'Iris Invited',
      email: 'iris.invited@example.com',
      jersey: 21,
      status: 'PENDING' as const,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    {
      id: LAKERS_MANAGED_IDS.XANDER_EXPIRED,
      name: 'Xander Expired',
      email: 'xander.expired@example.com',
      jersey: 22,
      status: 'PENDING' as const,
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      // The invite never arrived: the address hard-bounced (#449). Drives the
      // "Email bounced" chip and .maestro/roster-email-bounced.yaml.
      bounced: true,
    },
    {
      id: LAKERS_MANAGED_IDS.WENDY_WEBACCEPT,
      name: 'Wendy WebAccept',
      email: 'wendy.webaccept@example.com',
      jersey: 24,
      status: 'ACCEPTED' as const,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  ];

  for (const fixture of inviteStateFixtures) {
    const deliveryState =
      'bounced' in fixture && fixture.bounced
        ? { emailSuppressedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), emailSuppressedReason: 'BOUNCE' as const }
        : { emailSuppressedAt: null, emailSuppressedReason: null };

    const fixturePlayer = await prisma.user.upsert({
      where: { id: fixture.id },
      // Restored on every seed: roster-email-bounced.yaml corrects Xander's
      // address, which changes the email and clears the delivery state.
      update: { email: fixture.email, ...deliveryState },
      create: {
        id: fixture.id,
        name: fixture.name,
        email: fixture.email,
        role: UserRole.PLAYER,
        // Rostered-at-creation case 2: coach-managed until claimed
        isManaged: true,
        managedById: coachFrank.id,
        ...deliveryState,
      },
    });

    await prisma.teamMember.upsert({
      where: { teamId_playerId: { teamId: lakers.id, playerId: fixturePlayer.id } },
      update: {},
      create: {
        teamId: lakers.id,
        playerId: fixturePlayer.id,
        jerseyNumber: fixture.jersey,
      },
    });

    // Random token per run — the fixtures are asserted by name/chip, never by
    // token, and a committed bearer secret must not exist (security review).
    // Delete-then-create keeps re-seeds deterministic after QA interaction: a
    // manual Resend (supersede) leaves EXPIRED + PENDING rows, and updating an
    // arbitrary findFirst row could re-PENDING the old one alongside the live
    // one — violating the partial unique pending index (red-team review).
    await prisma.teamInvitation.deleteMany({
      where: { teamId: lakers.id, playerId: fixturePlayer.id },
    });
    await prisma.teamInvitation.create({
      data: {
        teamId: lakers.id,
        playerId: fixturePlayer.id,
        invitedById: coachFrank.id,
        token: randomBytes(32).toString('base64url'),
        status: fixture.status,
        expiresAt: fixture.expiresAt,
        ...(fixture.status === 'ACCEPTED' ? { acceptedAt: new Date() } : {}),
      },
    });
    console.log(`    Added invite-state fixture: ${fixture.name} (${fixture.status}) to Lakers`);
  }

  // =========================================================================
  // GAMES
  // =========================================================================
  console.log('\nCreating games...');

  // Restored on every seed, not only created (#788): date, status and scores
  // go back to the seeded values and every RSVP on these games is deleted.
  // guardian-rsvp.yaml taps "Going" as Steph on Warriors vs Lakers and,
  // with player-no-tracking.yaml, asserts that game is "Scheduled"; a
  // leftover RSVP or a game started by hand used to survive every reseed.
  const games = seededGames(new Date(), { warriorsId: warriors.id, lakersId: lakers.id });
  const restoredGames = await restoreSeededGames(prisma, games);
  for (const game of games) {
    console.log(`  Created game: ${game.label}`);
  }
  if (restoredGames.rsvps + restoredGames.events > 0) {
    console.log(
      `    Removed ${restoredGames.rsvps} RSVP(s) and ${restoredGames.events} event(s) from the seeded games`
    );
  }

  // =========================================================================
  // GAME EVENTS (for finished games)
  // =========================================================================
  console.log('\nCreating game events for finished games...');

  // The event logs live in tests/support/seed-fixtures.ts; homeScore is
  // derived from them with GameEventService.computeHomeScore on every run
  // (#787), never written by hand. seed-fixtures.test.ts pins the totals.
  const lastWeek = games.find((game) => game.id === SEED_IDS.WARRIORS_VS_HEAT_GAME)!.date;

  const warriorsEvents = warriorsVsHeatEvents(
    SEED_IDS.WARRIORS_VS_HEAT_GAME,
    {
      steph: players['steph.curry@example.com'].id,
      klay: players['klay.thompson@example.com'].id,
      draymond: players['draymond.green@example.com'].id,
      wiggins: players['andrew.wiggins@example.com'].id,
      poole: players['jordan.poole@example.com'].id,
    },
    lastWeek
  );
  const warriorsScore = await writeFinishedGameEvents(prisma, SEED_IDS.WARRIORS_VS_HEAT_GAME, warriorsEvents);
  console.log(`  Created ${warriorsEvents.length} events for Warriors vs Heat game (home score ${warriorsScore})`);

  const lakersEvents = lakersVsSunsEvents(
    SEED_IDS.LAKERS_VS_SUNS_GAME,
    {
      lebron: players['lebron.james@example.com'].id,
      ad: players['anthony.davis@example.com'].id,
      russ: players['russell.westbrook@example.com'].id,
      reaves: players['austin.reaves@example.com'].id,
      dlo: players['dangelo.russell@example.com'].id,
    },
    lastWeek
  );
  const lakersScore = await writeFinishedGameEvents(prisma, SEED_IDS.LAKERS_VS_SUNS_GAME, lakersEvents);
  console.log(`  Created ${lakersEvents.length} events for Lakers vs Suns game (home score ${lakersScore})`);

  // =========================================================================
  // CALCULATE AND STORE STATS FOR FINISHED GAMES
  // =========================================================================
  console.log('\nCalculating stats for finished games...');

  // Import the stats service dynamically to avoid circular dependency
  const { StatsService } = await import('../src/services/stats-service');

  try {
    await StatsService.finalizeGameStats(SEED_IDS.WARRIORS_VS_HEAT_GAME);
    console.log('  Calculated stats for Warriors vs Heat');
  } catch (error) {
    console.error('  Error calculating Warriors stats:', error);
  }

  try {
    await StatsService.finalizeGameStats(SEED_IDS.LAKERS_VS_SUNS_GAME);
    console.log('  Calculated stats for Lakers vs Suns');
  } catch (error) {
    console.error('  Error calculating Lakers stats:', error);
  }

  console.log('\n--- Seeding Complete ---\n');
  console.log('Test accounts:');
  console.log('  Admin: admin@bball-tracker.com');
  console.log('  Coach (Warriors): steve.kerr@example.com');
  console.log('  Coach (Lakers): frank.vogel@example.com');
  console.log('  Assistant Coach: mike.brown@example.com');
  console.log('  New signup, PLAYER, no team/league (#442 fixture): dana.whitfield@example.com');
  console.log('  Parent (Team Manager): dell.curry@example.com');
  console.log('  Parent: sonya.curry@example.com, gloria.james@example.com');
  console.log('  Players: steph.curry@example.com, lebron.james@example.com, etc.');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
