/**
 * Reset script - clears all data so the seed can start from nothing.
 * LOCAL DEVELOPMENT ONLY.
 *
 * Run with: npm run db:reset   (or npm run db:fresh, which seeds afterwards)
 *
 * Refuses to run unless DATABASE_URL names a local database (#784): both
 * NODE_ENV=production and an RDS host are refused, as the seed does, and so is
 * any host that is not loopback or the docker-compose service. The realistic
 * accident is not NODE_ENV=production; it is a local shell (NODE_ENV unset)
 * with DATABASE_URL still exported for production from a runbook step. There
 * is no override variable. The guard lives in prisma/reset-guard.ts and runs
 * before the Prisma client is even constructed.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { assertResetAllowed } from './reset-guard';

async function reset() {
  // First statement, before any client or query exists: throws on anything
  // that is not a local database.
  assertResetAllowed();

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log('Resetting database...\n');

    // Delete in order of dependencies (child tables first)
    console.log('Deleting game events...');
    const deletedEvents = await prisma.gameEvent.deleteMany();
    console.log(`  Deleted ${deletedEvents.count} game events`);

    console.log('Deleting games...');
    const deletedGames = await prisma.game.deleteMany();
    console.log(`  Deleted ${deletedGames.count} games`);

    console.log('Deleting player stats...');
    const deletedPlayerStats = await prisma.playerStats.deleteMany();
    console.log(`  Deleted ${deletedPlayerStats.count} player stats`);

    console.log('Deleting team stats...');
    const deletedTeamStats = await prisma.teamStats.deleteMany();
    console.log(`  Deleted ${deletedTeamStats.count} team stats`);

    console.log('Deleting team invitations...');
    const deletedInvitations = await prisma.teamInvitation.deleteMany();
    console.log(`  Deleted ${deletedInvitations.count} invitations`);

    console.log('Deleting team members...');
    const deletedMembers = await prisma.teamMember.deleteMany();
    console.log(`  Deleted ${deletedMembers.count} team members`);

    console.log('Deleting team staff...');
    const deletedStaff = await prisma.teamStaff.deleteMany();
    console.log(`  Deleted ${deletedStaff.count} team staff`);

    console.log('Deleting team roles...');
    const deletedRoles = await prisma.teamRole.deleteMany();
    console.log(`  Deleted ${deletedRoles.count} team roles`);

    console.log('Deleting teams...');
    const deletedTeams = await prisma.team.deleteMany();
    console.log(`  Deleted ${deletedTeams.count} teams`);

    console.log('Deleting seasons...');
    const deletedSeasons = await prisma.season.deleteMany();
    console.log(`  Deleted ${deletedSeasons.count} seasons`);

    console.log('Deleting league admins...');
    const deletedLeagueAdmins = await prisma.leagueAdmin.deleteMany();
    console.log(`  Deleted ${deletedLeagueAdmins.count} league admins`);

    console.log('Deleting leagues...');
    const deletedLeagues = await prisma.league.deleteMany();
    console.log(`  Deleted ${deletedLeagues.count} leagues`);

    console.log('Deleting guardians...');
    const deletedGuardians = await prisma.guardian.deleteMany();
    console.log(`  Deleted ${deletedGuardians.count} guardians`);

    console.log('Deleting refresh tokens...');
    const deletedTokens = await prisma.refreshToken.deleteMany();
    console.log(`  Deleted ${deletedTokens.count} refresh tokens`);

    console.log('Deleting users...');
    const deletedUsers = await prisma.user.deleteMany();
    console.log(`  Deleted ${deletedUsers.count} users`);

    console.log('\n--- Database Reset Complete ---\n');
    console.log('Run `npm run db:seed` to re-populate with test data.');
  } finally {
    await prisma.$disconnect();
  }
}

reset().catch((e: unknown) => {
  console.error('Reset refused or failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
