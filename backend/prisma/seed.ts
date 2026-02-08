/**
 * Seed script - creates test data for development
 * Run with: npm run db:seed
 */

import { PrismaClient, UserRole, TeamRoleType, GuardianRelationship, GameEventType } from '@prisma/client';

const prisma = new PrismaClient();

// Deterministic UUIDs for seed data (reproducible across runs)
const SEED_IDS = {
  LEAGUE: '10000000-0000-4000-a000-000000000001',
  WARRIORS_TEAM: '20000000-0000-4000-a000-000000000001',
  LAKERS_TEAM: '20000000-0000-4000-a000-000000000002',
  WARRIORS_VS_LAKERS_GAME: '30000000-0000-4000-a000-000000000001',
  WARRIORS_VS_CELTICS_GAME: '30000000-0000-4000-a000-000000000002',
  WARRIORS_VS_HEAT_GAME: '30000000-0000-4000-a000-000000000003',
  LAKERS_VS_WARRIORS_GAME: '30000000-0000-4000-a000-000000000004',
  LAKERS_VS_SUNS_GAME: '30000000-0000-4000-a000-000000000005',
};

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

  // =========================================================================
  // TEAMS
  // =========================================================================
  console.log('\nCreating teams...');

  // Warriors
  const warriors = await prisma.team.upsert({
    where: { id: SEED_IDS.WARRIORS_TEAM },
    update: {},
    create: {
      id: SEED_IDS.WARRIORS_TEAM,
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
    where: { id: SEED_IDS.LAKERS_TEAM },
    update: {},
    create: {
      id: SEED_IDS.LAKERS_TEAM,
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
  // MANAGED PLAYERS (COPPA-compliant, no email required)
  // =========================================================================
  console.log('\nCreating managed players...');

  // Warriors managed players (managed by Coach Steve Kerr)
  const managedWarriorsPlayers = [
    { name: 'Tommy Wilson', jersey: 5, position: 'PG' },
    { name: 'Jake Martinez', jersey: 12, position: 'SF' },
    { name: 'Ryan Chen', jersey: 8, position: 'C' },
  ];

  for (const mp of managedWarriorsPlayers) {
    const managedPlayer = await prisma.user.upsert({
      where: { id: `managed-warriors-${mp.jersey}` },
      update: {},
      create: {
        id: `managed-warriors-${mp.jersey}`,
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

  // Lakers managed players (managed by Coach Frank Vogel)
  const managedLakersPlayers = [
    { name: 'Marcus Johnson', jersey: 7, position: 'SG' },
    { name: 'Ethan Williams', jersey: 14, position: 'PF' },
  ];

  for (const mp of managedLakersPlayers) {
    const managedPlayer = await prisma.user.upsert({
      where: { id: `managed-lakers-${mp.jersey}` },
      update: {},
      create: {
        id: `managed-lakers-${mp.jersey}`,
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
    where: { id: SEED_IDS.WARRIORS_VS_LAKERS_GAME },
    update: {},
    create: {
      id: SEED_IDS.WARRIORS_VS_LAKERS_GAME,
      teamId: warriors.id,
      opponent: 'Lakers',
      date: tomorrow,
      status: 'SCHEDULED',
    },
  });
  console.log(`  Created game: Warriors vs Lakers (Scheduled - tomorrow)`);

  await prisma.game.upsert({
    where: { id: SEED_IDS.WARRIORS_VS_CELTICS_GAME },
    update: {},
    create: {
      id: SEED_IDS.WARRIORS_VS_CELTICS_GAME,
      teamId: warriors.id,
      opponent: 'Celtics',
      date: nextWeek,
      status: 'SCHEDULED',
    },
  });
  console.log(`  Created game: Warriors vs Celtics (Scheduled - next week)`);

  await prisma.game.upsert({
    where: { id: SEED_IDS.WARRIORS_VS_HEAT_GAME },
    update: {},
    create: {
      id: SEED_IDS.WARRIORS_VS_HEAT_GAME,
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
    where: { id: SEED_IDS.LAKERS_VS_WARRIORS_GAME },
    update: {},
    create: {
      id: SEED_IDS.LAKERS_VS_WARRIORS_GAME,
      teamId: lakers.id,
      opponent: 'Warriors',
      date: tomorrow,
      status: 'SCHEDULED',
    },
  });
  console.log(`  Created game: Lakers vs Warriors (Scheduled - tomorrow)`);

  await prisma.game.upsert({
    where: { id: SEED_IDS.LAKERS_VS_SUNS_GAME },
    update: {},
    create: {
      id: SEED_IDS.LAKERS_VS_SUNS_GAME,
      teamId: lakers.id,
      opponent: 'Suns',
      date: lastWeek,
      status: 'FINISHED',
      homeScore: 98,
      awayScore: 102,
    },
  });
  console.log(`  Created game: Lakers vs Suns (Finished - 98-102)`);

  // =========================================================================
  // GAME EVENTS (for finished games)
  // =========================================================================
  console.log('\nCreating game events for finished games...');

  // Helper to create events
  const createShotEvent = (gameId: string, playerId: string, made: boolean, points: number, timestamp: Date) => ({
    gameId,
    playerId,
    eventType: GameEventType.SHOT,
    timestamp,
    metadata: { made, points },
  });

  const createReboundEvent = (gameId: string, playerId: string, type: 'offensive' | 'defensive', timestamp: Date) => ({
    gameId,
    playerId,
    eventType: GameEventType.REBOUND,
    timestamp,
    metadata: { type },
  });

  const createSimpleEvent = (gameId: string, playerId: string, eventType: GameEventType, timestamp: Date) => ({
    gameId,
    playerId,
    eventType,
    timestamp,
    metadata: {},
  });

  // Clear existing events for these games first
  await prisma.gameEvent.deleteMany({
    where: { gameId: { in: [SEED_IDS.WARRIORS_VS_HEAT_GAME, SEED_IDS.LAKERS_VS_SUNS_GAME] } },
  });

  // -------------------------------------------------------------------------
  // Warriors vs Heat (112-105) - Warriors stat lines
  // -------------------------------------------------------------------------
  // Steph Curry: 32 pts (10-18 FG, 6-12 3PT, 6-6 FT), 5 reb, 8 ast, 2 stl, 0 blk, 3 TO, 2 fouls
  // Klay Thompson: 25 pts (9-17 FG, 5-10 3PT, 2-2 FT), 4 reb, 2 ast, 1 stl, 0 blk, 1 TO, 3 fouls
  // Draymond Green: 12 pts (5-9 FG, 1-3 3PT, 1-2 FT), 10 reb, 7 ast, 2 stl, 2 blk, 4 TO, 4 fouls
  // Andrew Wiggins: 22 pts (8-14 FG, 2-5 3PT, 4-5 FT), 6 reb, 2 ast, 1 stl, 1 blk, 2 TO, 2 fouls
  // Jordan Poole: 21 pts (7-15 FG, 3-8 3PT, 4-4 FT), 3 reb, 4 ast, 0 stl, 0 blk, 2 TO, 3 fouls
  // Total: 112 pts

  const warriorsGameId = SEED_IDS.WARRIORS_VS_HEAT_GAME;
  const stephId = players['steph.curry@example.com'].id;
  const klayId = players['klay.thompson@example.com'].id;
  const draymondId = players['draymond.green@example.com'].id;
  const wigginsId = players['andrew.wiggins@example.com'].id;
  const pooleId = players['jordan.poole@example.com'].id;

  const warriorsEvents: Array<{
    gameId: string;
    playerId: string;
    eventType: GameEventType;
    timestamp: Date;
    metadata: object;
  }> = [];
  let eventTime = new Date(lastWeek);

  // Steph Curry events
  // 2-pointers: 4 made, 2 missed (4*2=8 pts from 2s)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, true, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, false, 2, eventTime));
  }
  // 3-pointers: 6 made, 6 missed (6*3=18 pts from 3s)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, true, 3, eventTime));
  }
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, false, 3, eventTime));
  }
  // Free throws: 6 made (6 pts)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, stephId, true, 1, eventTime));
  }
  // Rebounds: 3 def, 2 off
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, stephId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, stephId, 'offensive', eventTime));
  }
  // Assists: 8
  for (let i = 0; i < 8; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.ASSIST, eventTime));
  }
  // Steals: 2
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.STEAL, eventTime));
  }
  // Turnovers: 3
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.TURNOVER, eventTime));
  }
  // Fouls: 2
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, stephId, GameEventType.FOUL, eventTime));
  }

  // Klay Thompson events - 25 pts (4 2PT made, 3 missed, 5 3PT made, 5 missed, 2 FT made)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, true, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, false, 2, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, true, 3, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, false, 3, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, klayId, true, 1, eventTime));
  }
  // 4 rebounds, 2 assists, 1 steal, 1 TO, 3 fouls
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, klayId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.ASSIST, eventTime));
  }
  warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.TURNOVER, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, klayId, GameEventType.FOUL, eventTime));
  }

  // Draymond Green events - 12 pts (4 2PT made, 2 missed, 1 3PT made, 2 missed, 1 FT made, 1 missed)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, true, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, false, 2, eventTime));
  }
  warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, true, 3, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, false, 3, eventTime));
  }
  warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, true, 1, new Date(eventTime.getTime() + 60000)));
  warriorsEvents.push(createShotEvent(warriorsGameId, draymondId, false, 1, new Date(eventTime.getTime() + 120000)));
  // 10 rebounds (7 def, 3 off), 7 assists, 2 steals, 2 blocks, 4 TO, 4 fouls
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, draymondId, 'defensive', eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, draymondId, 'offensive', eventTime));
  }
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.STEAL, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.BLOCK, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, draymondId, GameEventType.FOUL, eventTime));
  }

  // Andrew Wiggins events - 22 pts (6 2PT made, 3 missed, 2 3PT made, 3 missed, 4 FT made, 1 missed)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, true, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, false, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, true, 3, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, false, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, true, 1, eventTime));
  }
  warriorsEvents.push(createShotEvent(warriorsGameId, wigginsId, false, 1, new Date(eventTime.getTime() + 60000)));
  // 6 rebounds, 2 assists, 1 steal, 1 block, 2 TO, 2 fouls
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, wigginsId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, wigginsId, 'offensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.ASSIST, eventTime));
  }
  warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.BLOCK, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, wigginsId, GameEventType.FOUL, eventTime));
  }

  // Jordan Poole events - 21 pts (4 2PT made, 4 missed, 3 3PT made, 5 missed, 4 FT made)
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, true, 2, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, false, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, true, 3, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, false, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createShotEvent(warriorsGameId, pooleId, true, 1, eventTime));
  }
  // 3 rebounds, 4 assists, 0 steals, 0 blocks, 2 TO, 3 fouls
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createReboundEvent(warriorsGameId, pooleId, 'defensive', eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, pooleId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, pooleId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    warriorsEvents.push(createSimpleEvent(warriorsGameId, pooleId, GameEventType.FOUL, eventTime));
  }

  // Insert all Warriors events
  await prisma.gameEvent.createMany({ data: warriorsEvents });
  console.log(`  Created ${warriorsEvents.length} events for Warriors vs Heat game`);

  // -------------------------------------------------------------------------
  // Lakers vs Suns (98-102) - Lakers stat lines
  // -------------------------------------------------------------------------
  // LeBron James: 28 pts (10-19 FG, 2-6 3PT, 6-8 FT), 8 reb, 9 ast, 1 stl, 1 blk, 4 TO, 2 fouls
  // Anthony Davis: 24 pts (9-16 FG, 0-1 3PT, 6-7 FT), 12 reb, 3 ast, 1 stl, 3 blk, 2 TO, 4 fouls
  // Russell Westbrook: 18 pts (7-15 FG, 1-4 3PT, 3-5 FT), 6 reb, 7 ast, 2 stl, 0 blk, 5 TO, 3 fouls
  // Austin Reaves: 15 pts (5-10 FG, 3-6 3PT, 2-2 FT), 3 reb, 4 ast, 1 stl, 0 blk, 1 TO, 2 fouls
  // D'Angelo Russell: 13 pts (4-12 FG, 3-7 3PT, 2-2 FT), 2 reb, 5 ast, 0 stl, 0 blk, 2 TO, 1 foul
  // Total: 98 pts

  const lakersGameId = SEED_IDS.LAKERS_VS_SUNS_GAME;
  const lebronId = players['lebron.james@example.com'].id;
  const adId = players['anthony.davis@example.com'].id;
  const russId = players['russell.westbrook@example.com'].id;
  const reavesId = players['austin.reaves@example.com'].id;
  const dloId = players['dangelo.russell@example.com'].id;

  const lakersEvents: Array<{
    gameId: string;
    playerId: string;
    eventType: GameEventType;
    timestamp: Date;
    metadata: object;
  }> = [];
  eventTime = new Date(lastWeek);

  // LeBron James events - 28 pts (8 2PT made, 5 missed, 2 3PT made, 4 missed, 6 FT made, 2 missed)
  for (let i = 0; i < 8; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, true, 2, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, false, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, true, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, false, 3, eventTime));
  }
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, true, 1, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, lebronId, false, 1, eventTime));
  }
  // 8 rebounds (6 def, 2 off), 9 assists, 1 steal, 1 block, 4 TO, 2 fouls
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, lebronId, 'defensive', eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, lebronId, 'offensive', eventTime));
  }
  for (let i = 0; i < 9; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.ASSIST, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.BLOCK, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, lebronId, GameEventType.FOUL, eventTime));
  }

  // Anthony Davis events - 24 pts (9 2PT made, 6 missed, 0 3PT made, 1 missed, 6 FT made, 1 missed)
  for (let i = 0; i < 9; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, adId, true, 2, eventTime));
  }
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, adId, false, 2, eventTime));
  }
  lakersEvents.push(createShotEvent(lakersGameId, adId, false, 3, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, adId, true, 1, eventTime));
  }
  lakersEvents.push(createShotEvent(lakersGameId, adId, false, 1, new Date(eventTime.getTime() + 60000)));
  // 12 rebounds (8 def, 4 off), 3 assists, 1 steal, 3 blocks, 2 TO, 4 fouls
  for (let i = 0; i < 8; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, adId, 'defensive', eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, adId, 'offensive', eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.ASSIST, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.BLOCK, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, adId, GameEventType.FOUL, eventTime));
  }

  // Russell Westbrook events - 18 pts (6 2PT made, 7 missed, 1 3PT made, 3 missed, 3 FT made, 2 missed)
  for (let i = 0; i < 6; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, true, 2, eventTime));
  }
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, false, 2, eventTime));
  }
  lakersEvents.push(createShotEvent(lakersGameId, russId, true, 3, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, false, 3, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, true, 1, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, russId, false, 1, eventTime));
  }
  // 6 rebounds, 7 assists, 2 steals, 0 blocks, 5 TO, 3 fouls
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, russId, 'defensive', eventTime));
  }
  lakersEvents.push(createReboundEvent(lakersGameId, russId, 'offensive', new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 7; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.STEAL, eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.TURNOVER, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, russId, GameEventType.FOUL, eventTime));
  }

  // Austin Reaves events - 15 pts (2 2PT made, 2 missed, 3 3PT made, 3 missed, 2 FT made)
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, true, 2, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, false, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, true, 3, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, false, 3, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, reavesId, true, 1, eventTime));
  }
  // 3 rebounds, 4 assists, 1 steal, 0 blocks, 1 TO, 2 fouls
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, reavesId, 'defensive', eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.ASSIST, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.STEAL, new Date(eventTime.getTime() + 60000)));
  lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.TURNOVER, new Date(eventTime.getTime() + 120000)));
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, reavesId, GameEventType.FOUL, eventTime));
  }

  // D'Angelo Russell events - 13 pts (1 2PT made, 3 missed, 3 3PT made, 4 missed, 2 FT made)
  lakersEvents.push(createShotEvent(lakersGameId, dloId, true, 2, new Date(eventTime.getTime() + 60000)));
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, false, 2, eventTime));
  }
  for (let i = 0; i < 3; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, true, 3, eventTime));
  }
  for (let i = 0; i < 4; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, false, 3, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createShotEvent(lakersGameId, dloId, true, 1, eventTime));
  }
  // 2 rebounds, 5 assists, 0 steals, 0 blocks, 2 TO, 1 foul
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createReboundEvent(lakersGameId, dloId, 'defensive', eventTime));
  }
  for (let i = 0; i < 5; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, dloId, GameEventType.ASSIST, eventTime));
  }
  for (let i = 0; i < 2; i++) {
    eventTime = new Date(eventTime.getTime() + 60000);
    lakersEvents.push(createSimpleEvent(lakersGameId, dloId, GameEventType.TURNOVER, eventTime));
  }
  lakersEvents.push(createSimpleEvent(lakersGameId, dloId, GameEventType.FOUL, new Date(eventTime.getTime() + 60000)));

  // Insert all Lakers events
  await prisma.gameEvent.createMany({ data: lakersEvents });
  console.log(`  Created ${lakersEvents.length} events for Lakers vs Suns game`);

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
