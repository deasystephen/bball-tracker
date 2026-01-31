/**
 * Seed script - creates test data for development
 * Run with: npm run db:seed
 */

import { PrismaClient, UserRole, TeamRoleType, GuardianRelationship } from '@prisma/client';

const prisma = new PrismaClient();

// Helper to create default team roles
async function createDefaultTeamRoles(teamId: string) {
  const roles = await prisma.teamRole.createMany({
    data: [
      {
        teamId,
        type: TeamRoleType.HEAD_COACH,
        name: 'Head Coach',
        description: 'Primary team coach with full administrative access',
        canManageTeam: true,
        canManageRoster: true,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
      {
        teamId,
        type: TeamRoleType.ASSISTANT_COACH,
        name: 'Assistant Coach',
        description: 'Assistant coach with team management access',
        canManageTeam: true,
        canManageRoster: true,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
      {
        teamId,
        type: TeamRoleType.TEAM_MANAGER,
        name: 'Team Manager',
        description: 'Team volunteer who helps with game day operations',
        canManageTeam: false,
        canManageRoster: false,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
    ],
  });

  return roles;
}

async function main() {
  console.log('Seeding database...\n');

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
    update: {},
    create: {
      email: 'steve.kerr@example.com',
      name: 'Steve Kerr',
      role: UserRole.COACH,
      emailVerified: true,
    },
  });
  console.log(`  Created coach: ${coachSteve.email}`);

  const coachFrank = await prisma.user.upsert({
    where: { email: 'frank.vogel@example.com' },
    update: {},
    create: {
      email: 'frank.vogel@example.com',
      name: 'Frank Vogel',
      role: UserRole.COACH,
      emailVerified: true,
    },
  });
  console.log(`  Created coach: ${coachFrank.email}`);

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
      update: {},
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

  // =========================================================================
  // LEAGUE & SEASON
  // =========================================================================
  console.log('\nCreating league and season...');

  const league = await prisma.league.upsert({
    where: { id: 'downtown-youth-league' },
    update: {},
    create: {
      id: 'downtown-youth-league',
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

  // =========================================================================
  // TEAMS
  // =========================================================================
  console.log('\nCreating teams...');

  // Warriors
  const warriors = await prisma.team.upsert({
    where: { id: 'warriors-spring-2024' },
    update: {},
    create: {
      id: 'warriors-spring-2024',
      name: 'Warriors',
      seasonId: season.id,
    },
  });
  console.log(`  Created team: ${warriors.name}`);

  // Create default roles for Warriors
  await createDefaultTeamRoles(warriors.id);
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

  // Lakers
  const lakers = await prisma.team.upsert({
    where: { id: 'lakers-spring-2024' },
    update: {},
    create: {
      id: 'lakers-spring-2024',
      name: 'Lakers',
      seasonId: season.id,
    },
  });
  console.log(`  Created team: ${lakers.name}`);

  // Create default roles for Lakers
  await createDefaultTeamRoles(lakers.id);
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
  // GAMES
  // =========================================================================
  console.log('\nCreating games...');

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Warriors games
  await prisma.game.upsert({
    where: { id: 'warriors-vs-lakers-1' },
    update: {},
    create: {
      id: 'warriors-vs-lakers-1',
      teamId: warriors.id,
      opponent: 'Lakers',
      date: tomorrow,
      status: 'SCHEDULED',
    },
  });
  console.log(`  Created game: Warriors vs Lakers (Scheduled - tomorrow)`);

  await prisma.game.upsert({
    where: { id: 'warriors-vs-celtics-1' },
    update: {},
    create: {
      id: 'warriors-vs-celtics-1',
      teamId: warriors.id,
      opponent: 'Celtics',
      date: nextWeek,
      status: 'SCHEDULED',
    },
  });
  console.log(`  Created game: Warriors vs Celtics (Scheduled - next week)`);

  await prisma.game.upsert({
    where: { id: 'warriors-vs-heat-1' },
    update: {},
    create: {
      id: 'warriors-vs-heat-1',
      teamId: warriors.id,
      opponent: 'Heat',
      date: lastWeek,
      status: 'FINISHED',
      homeScore: 112,
      awayScore: 105,
    },
  });
  console.log(`  Created game: Warriors vs Heat (Finished - 112-105)`);

  // Lakers games
  await prisma.game.upsert({
    where: { id: 'lakers-vs-warriors-1' },
    update: {},
    create: {
      id: 'lakers-vs-warriors-1',
      teamId: lakers.id,
      opponent: 'Warriors',
      date: tomorrow,
      status: 'SCHEDULED',
    },
  });
  console.log(`  Created game: Lakers vs Warriors (Scheduled - tomorrow)`);

  await prisma.game.upsert({
    where: { id: 'lakers-vs-suns-1' },
    update: {},
    create: {
      id: 'lakers-vs-suns-1',
      teamId: lakers.id,
      opponent: 'Suns',
      date: lastWeek,
      status: 'FINISHED',
      homeScore: 98,
      awayScore: 102,
    },
  });
  console.log(`  Created game: Lakers vs Suns (Finished - 98-102)`);

  console.log('\n--- Seeding Complete ---\n');
  console.log('Test accounts:');
  console.log('  Admin: admin@bball-tracker.com');
  console.log('  Coach (Warriors): steve.kerr@example.com');
  console.log('  Coach (Lakers): frank.vogel@example.com');
  console.log('  Assistant Coach: mike.brown@example.com');
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
