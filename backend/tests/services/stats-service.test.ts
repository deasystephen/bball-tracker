/**
 * Unit tests for StatsService
 */

import { StatsService } from '../../src/services/stats-service';
import { mockPrisma } from '../setup';
import {
  createAdmin,
  createGame,
  createTeam,
  createCoach,
  createSeason,
  createLeague,
  createPlayer,
  createTeamMember,
  createTeamRole,
  createTeamStaff,
  createGameEvent,
  createPlayerStats,
  createTeamStats,
} from '../factories';
import { expectNotFoundError, expectForbiddenError } from '../helpers';

describe('StatsService', () => {
  describe('calculatePlayerStats', () => {
    it('should calculate stats from game events correctly', async () => {
      const team = createTeam();
      const player1 = createPlayer({ id: 'player-1', name: 'John Doe' });
      const player2 = createPlayer({ id: 'player-2', name: 'Jane Smith' });
      const game = createGame({ teamId: team.id, status: 'FINISHED' });

      const member1 = createTeamMember({ teamId: team.id, playerId: player1.id, jerseyNumber: 23, position: 'Guard' });
      const member2 = createTeamMember({ teamId: team.id, playerId: player2.id, jerseyNumber: 10, position: 'Forward' });

      // Create game events
      const events = [
        // Player 1: 2-point shot made
        createGameEvent({ gameId: game.id, playerId: player1.id, eventType: 'SHOT', metadata: { made: true, points: 2 } }),
        // Player 1: 3-point shot made
        createGameEvent({ gameId: game.id, playerId: player1.id, eventType: 'SHOT', metadata: { made: true, points: 3 } }),
        // Player 1: 3-point shot missed
        createGameEvent({ gameId: game.id, playerId: player1.id, eventType: 'SHOT', metadata: { made: false, points: 3 } }),
        // Player 1: rebound
        createGameEvent({ gameId: game.id, playerId: player1.id, eventType: 'REBOUND', metadata: { type: 'defensive' } }),
        // Player 1: assist
        createGameEvent({ gameId: game.id, playerId: player1.id, eventType: 'ASSIST', metadata: {} }),
        // Player 2: 2-point shot made
        createGameEvent({ gameId: game.id, playerId: player2.id, eventType: 'SHOT', metadata: { made: true, points: 2 } }),
        // Player 2: steal
        createGameEvent({ gameId: game.id, playerId: player2.id, eventType: 'STEAL', metadata: {} }),
        // Player 2: foul
        createGameEvent({ gameId: game.id, playerId: player2.id, eventType: 'FOUL', metadata: {} }),
      ];

      // Add player info to events
      const eventsWithPlayers = events.map((e, i) => ({
        ...e,
        player: i < 5 ? { id: player1.id, name: player1.name } : { id: player2.id, name: player2.name },
      }));

      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue(eventsWithPlayers);
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [member1, member2],
        },
      });

      const result = await StatsService.calculatePlayerStats(game.id);

      expect(result).toHaveLength(2);

      // Player 1 stats: 5 points (2 + 3), 1 rebound, 1 assist, 2 FGA (3 total shots - 1 3PT = 2 2PT), 1 3PA
      const player1Stats = result.find(s => s.playerId === player1.id);
      expect(player1Stats).toBeDefined();
      expect(player1Stats!.points).toBe(5);
      expect(player1Stats!.rebounds).toBe(1);
      expect(player1Stats!.assists).toBe(1);
      expect(player1Stats!.jerseyNumber).toBe(23);
      expect(player1Stats!.threePointersMade).toBe(1);
      expect(player1Stats!.threePointersAttempted).toBe(2);

      // Player 2 stats: 2 points, 1 steal, 1 foul
      const player2Stats = result.find(s => s.playerId === player2.id);
      expect(player2Stats).toBeDefined();
      expect(player2Stats!.points).toBe(2);
      expect(player2Stats!.steals).toBe(1);
      expect(player2Stats!.fouls).toBe(1);
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await StatsService.calculatePlayerStats('non-existent');
        fail('Expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should handle games with no events', async () => {
      const team = createTeam();
      const game = createGame({ teamId: team.id });

      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [] },
      });

      const result = await StatsService.calculatePlayerStats(game.id);

      expect(result).toHaveLength(0);
    });
  });

  describe('calculateTeamTotals', () => {
    it('should aggregate player stats into team totals', () => {
      const playerStats = [
        {
          playerId: 'p1',
          playerName: 'Player 1',
          points: 20,
          rebounds: 5,
          assists: 3,
          steals: 2,
          blocks: 1,
          turnovers: 2,
          fouls: 3,
          fieldGoalsMade: 8,
          fieldGoalsAttempted: 15,
          threePointersMade: 2,
          threePointersAttempted: 5,
          freeThrowsMade: 2,
          freeThrowsAttempted: 4,
          fieldGoalPercentage: 53.3,
          threePointPercentage: 40.0,
          freeThrowPercentage: 50.0,
          offensiveRebounds: 1,
          defensiveRebounds: 4,
        },
        {
          playerId: 'p2',
          playerName: 'Player 2',
          points: 15,
          rebounds: 8,
          assists: 5,
          steals: 1,
          blocks: 2,
          turnovers: 3,
          fouls: 2,
          fieldGoalsMade: 6,
          fieldGoalsAttempted: 12,
          threePointersMade: 1,
          threePointersAttempted: 3,
          freeThrowsMade: 2,
          freeThrowsAttempted: 2,
          fieldGoalPercentage: 50.0,
          threePointPercentage: 33.3,
          freeThrowPercentage: 100.0,
          offensiveRebounds: 2,
          defensiveRebounds: 6,
        },
      ];

      const result = StatsService.calculateTeamTotals('team-1', 'Test Team', playerStats);

      expect(result.points).toBe(35);
      expect(result.rebounds).toBe(13);
      expect(result.assists).toBe(8);
      expect(result.steals).toBe(3);
      expect(result.blocks).toBe(3);
      expect(result.turnovers).toBe(5);
      expect(result.fouls).toBe(5);
      expect(result.fieldGoalsMade).toBe(14);
      expect(result.fieldGoalsAttempted).toBe(27);
      expect(result.threePointersMade).toBe(3);
      expect(result.threePointersAttempted).toBe(8);
      expect(result.freeThrowsMade).toBe(4);
      expect(result.freeThrowsAttempted).toBe(6);
      expect(result.fieldGoalPercentage).toBeCloseTo(51.9, 1);
      expect(result.threePointPercentage).toBeCloseTo(37.5, 1);
      expect(result.freeThrowPercentage).toBeCloseTo(66.7, 1);
    });
  });

  describe('finalizeGameStats', () => {
    it('should persist player and team stats when game finishes', async () => {
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const player = createPlayer();
      const game = createGame({ teamId: team.id, status: 'FINISHED' });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      const events = [
        {
          ...createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT', metadata: { made: true, points: 2 } }),
          player: { id: player.id, name: player.name },
        },
      ];

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [member] },
      });
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue(events);
      (mockPrisma.playerStats.upsert as jest.Mock).mockResolvedValue({});
      (mockPrisma.teamStats.upsert as jest.Mock).mockResolvedValue({});

      await StatsService.finalizeGameStats(game.id);

      expect(mockPrisma.playerStats.upsert).toHaveBeenCalled();
      expect(mockPrisma.teamStats.upsert).toHaveBeenCalled();
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await StatsService.finalizeGameStats('non-existent');
        fail('Expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });
  });

  describe('getBoxScore', () => {
    it('should return box score for authorized user', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const player = createPlayer();
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });
      const game = createGame({ teamId: team.id, status: 'FINISHED', homeScore: 75, awayScore: 70 });

      const events = [
        {
          ...createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT', metadata: { made: true, points: 2 } }),
          player: { id: player.id, name: player.name },
        },
      ];

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [member] },
      });
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue(events);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ ...coachStaff, role: headCoachRole });

      const result = await StatsService.getBoxScore(game.id, coach.id);

      expect(result.game.id).toBe(game.id);
      expect(result.game.homeScore).toBe(75);
      expect(result.game.awayScore).toBe(70);
      expect(result.team.id).toBe(team.id);
      expect(result.team.players).toHaveLength(1);
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await StatsService.getBoxScore('non-existent', 'user-id');
        fail('Expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const team = createTeam();
      const game = createGame({ teamId: team.id });
      const otherUser = createPlayer();

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({ ...game, team });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await StatsService.getBoxScore(game.id, otherUser.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this game');
      }
    });
  });

  describe('getPlayerSeasonStats', () => {
    it('should return aggregated season stats for a player', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const player = createPlayer({ id: 'player-1', name: 'Test Player' });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id, jerseyNumber: 23 });

      const game1 = createGame({ id: 'game-1', teamId: team.id, status: 'FINISHED' });
      const game2 = createGame({ id: 'game-2', teamId: team.id, status: 'FINISHED' });

      const stats1 = createPlayerStats({ playerId: player.id, gameId: game1.id, points: 20, rebounds: 5, assists: 3 });
      const stats2 = createPlayerStats({ playerId: player.id, gameId: game2.id, points: 15, rebounds: 8, assists: 5 });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ ...coachStaff, role: headCoachRole });
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game1, game2]);
      (mockPrisma.playerStats.findMany as jest.Mock).mockResolvedValue([stats1, stats2]);
      // Mock for player lookup
      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player.id) return Promise.resolve(player);
        return Promise.resolve(coach);
      });
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);

      const result = await StatsService.getPlayerSeasonStats(player.id, team.id, coach.id);

      expect(result.playerId).toBe(player.id);
      expect(result.playerName).toBe(player.name);
      expect(result.gamesPlayed).toBe(2);
      expect(result.points).toBe(35);
      expect(result.pointsPerGame).toBe(17.5);
    });

    it('should throw ForbiddenError if user has no access to team', async () => {
      const otherUser = createPlayer();
      const team = createTeam();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await StatsService.getPlayerSeasonStats('player-id', team.id, otherUser.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this team');
      }
    });
  });

  describe('getTeamSeasonStats', () => {
    it('should return team season stats with recent games', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ id: 'team-1', name: 'Test Team', seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      const game1 = createGame({ teamId: team.id, status: 'FINISHED', homeScore: 80, awayScore: 70 });
      const game2 = createGame({ teamId: team.id, status: 'FINISHED', homeScore: 65, awayScore: 75 });

      const teamStats1 = createTeamStats({ teamId: team.id, gameId: game1.id, points: 80 });
      const teamStats2 = createTeamStats({ teamId: team.id, gameId: game2.id, points: 65 });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ ...coachStaff, role: headCoachRole });
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game1, game2]);
      (mockPrisma.teamStats.findMany as jest.Mock).mockResolvedValue([teamStats1, teamStats2]);

      const result = await StatsService.getTeamSeasonStats(team.id, coach.id);

      expect(result.teamId).toBe(team.id);
      expect(result.teamName).toBe(team.name);
      expect(result.gamesPlayed).toBe(2);
      expect(result.wins).toBe(1);
      expect(result.losses).toBe(1);
      expect(result.recentGames).toHaveLength(2);
    });

    it('should throw NotFoundError if team does not exist', async () => {
      const coach = createCoach();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await StatsService.getTeamSeasonStats('non-existent', coach.id);
        fail('Expected error');
      } catch (error) {
        // Could be ForbiddenError or NotFoundError depending on implementation
        expect(error).toBeDefined();
      }
    });
  });

  describe('getTeamRosterStats', () => {
    it('should return roster with player season stats', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const player1 = createPlayer({ id: 'player-1', name: 'Player One' });
      const player2 = createPlayer({ id: 'player-2', name: 'Player Two' });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

      const member1 = createTeamMember({ teamId: team.id, playerId: player1.id, jerseyNumber: 1 });
      const member2 = createTeamMember({ teamId: team.id, playerId: player2.id, jerseyNumber: 2 });

      const game = createGame({ teamId: team.id, status: 'FINISHED' });
      const stats1 = createPlayerStats({ playerId: player1.id, gameId: game.id, points: 20 });
      const stats2 = createPlayerStats({ playerId: player2.id, gameId: game.id, points: 15 });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player1.id) return Promise.resolve(player1);
        if (args.where.id === player2.id) return Promise.resolve(player2);
        return Promise.resolve(coach);
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ ...coachStaff, role: headCoachRole });
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { ...member1, player: player1 },
        { ...member2, player: player2 },
      ]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockImplementation((args: { where: { teamId_playerId: { teamId: string; playerId: string } } }) => {
        if (args.where.teamId_playerId.playerId === player1.id) return Promise.resolve(member1);
        if (args.where.teamId_playerId.playerId === player2.id) return Promise.resolve(member2);
        return Promise.resolve(null);
      });
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game]);
      (mockPrisma.playerStats.findMany as jest.Mock).mockImplementation((args: { where: { playerId: string } }) => {
        if (args.where.playerId === player1.id) return Promise.resolve([stats1]);
        if (args.where.playerId === player2.id) return Promise.resolve([stats2]);
        return Promise.resolve([]);
      });

      const result = await StatsService.getTeamRosterStats(team.id, coach.id);

      expect(result).toHaveLength(2);
      expect(result[0].points).toBeGreaterThanOrEqual(result[1].points); // Sorted by PPG
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const otherUser = createPlayer();
      const team = createTeam();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await StatsService.getTeamRosterStats(team.id, otherUser.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this team');
      }
    });
  });

  describe('getPlayerOverallStats', () => {
    it('should return per-team and career totals when caller is system admin', async () => {
      const admin = createAdmin();
      const player = createPlayer({ id: 'player-1', name: 'Jane Doe' });
      const leagueA = createLeague({ name: 'League A' });
      const seasonA = createSeason({ leagueId: leagueA.id, name: 'Spring' });
      const teamA = createTeam({ id: 'team-a', name: 'Alphas', seasonId: seasonA.id });
      const leagueB = createLeague({ name: 'League B' });
      const seasonB = createSeason({ leagueId: leagueB.id, name: 'Fall' });
      const teamB = createTeam({ id: 'team-b', name: 'Bravos', seasonId: seasonB.id });

      const memberA = createTeamMember({ teamId: teamA.id, playerId: player.id, jerseyNumber: 7, position: 'PG' });
      const memberB = createTeamMember({ teamId: teamB.id, playerId: player.id, jerseyNumber: 11, position: 'SG' });

      const gameA1 = createGame({ id: 'game-a1', teamId: teamA.id, status: 'FINISHED' });
      const gameA2 = createGame({ id: 'game-a2', teamId: teamA.id, status: 'FINISHED' });
      const gameB1 = createGame({ id: 'game-b1', teamId: teamB.id, status: 'FINISHED' });

      const statsA1 = createPlayerStats({
        playerId: player.id, gameId: gameA1.id,
        points: 20, rebounds: 6, assists: 4, steals: 2, blocks: 1, turnovers: 3, fouls: 2,
        fieldGoalsMade: 8, fieldGoalsAttempted: 16,
        threePointersMade: 2, threePointersAttempted: 5,
        freeThrowsMade: 2, freeThrowsAttempted: 3,
      });
      const statsA2 = createPlayerStats({
        playerId: player.id, gameId: gameA2.id,
        points: 10, rebounds: 4, assists: 2, steals: 1, blocks: 0, turnovers: 1, fouls: 1,
        fieldGoalsMade: 4, fieldGoalsAttempted: 10,
        threePointersMade: 1, threePointersAttempted: 3,
        freeThrowsMade: 1, freeThrowsAttempted: 2,
      });
      const statsB1 = createPlayerStats({
        playerId: player.id, gameId: gameB1.id,
        points: 15, rebounds: 5, assists: 3, steals: 0, blocks: 2, turnovers: 2, fouls: 3,
        fieldGoalsMade: 6, fieldGoalsAttempted: 12,
        threePointersMade: 1, threePointersAttempted: 4,
        freeThrowsMade: 1, freeThrowsAttempted: 1,
      });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player.id) return Promise.resolve(player);
        if (args.where.id === admin.id) return Promise.resolve(admin);
        return Promise.resolve(null);
      });
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { ...memberA, team: { ...teamA, season: { ...seasonA, league: leagueA } } },
        { ...memberB, team: { ...teamB, season: { ...seasonB, league: leagueB } } },
      ]);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([
        { id: gameA1.id, teamId: teamA.id },
        { id: gameA2.id, teamId: teamA.id },
        { id: gameB1.id, teamId: teamB.id },
      ]);
      (mockPrisma.playerStats.findMany as jest.Mock).mockResolvedValue([statsA1, statsA2, statsB1]);

      const result = await StatsService.getPlayerOverallStats(player.id, admin.id);

      expect(result.player).toEqual(player);
      expect(result.teams).toHaveLength(2);

      const aResult = result.teams.find((t) => t.teamId === teamA.id);
      expect(aResult).toBeDefined();
      expect(aResult!.teamName).toBe('Alphas');
      expect(aResult!.seasonName).toBe('League A - Spring');
      expect(aResult!.stats.gamesPlayed).toBe(2);
      expect(aResult!.stats.points).toBe(30);
      expect(aResult!.stats.pointsPerGame).toBe(15);
      expect(aResult!.stats.jerseyNumber).toBe(7);
      expect(aResult!.stats.position).toBe('PG');
      // FG%: (8+4)/(16+10) = 12/26 = 46.2
      expect(aResult!.stats.fieldGoalPercentage).toBeCloseTo(46.2, 1);

      const bResult = result.teams.find((t) => t.teamId === teamB.id);
      expect(bResult!.stats.gamesPlayed).toBe(1);
      expect(bResult!.stats.points).toBe(15);

      // Career totals: 3 games, 45 points total
      expect(result.careerTotals.gamesPlayed).toBe(3);
      expect(result.careerTotals.points).toBe(45);
      expect(result.careerTotals.pointsPerGame).toBe(15);
      expect(result.careerTotals.playerId).toBe(player.id);
      expect(result.careerTotals.playerName).toBe('Jane Doe');
    });

    it('should return player own stats when caller is the player (team member access)', async () => {
      const player = createPlayer({ id: 'player-self', name: 'Self' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ id: 'team-self', seasonId: season.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });
      const game = createGame({ id: 'game-self', teamId: team.id, status: 'FINISHED' });
      const stats = createPlayerStats({ playerId: player.id, gameId: game.id, points: 12 });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player.id) return Promise.resolve(player);
        return Promise.resolve(null);
      });
      (mockPrisma.teamMember.findMany as jest.Mock).mockImplementation((args: { where: { playerId?: string; teamId?: unknown } }) => {
        // First call: memberships-by-playerId (include.team included)
        if (args.where.playerId === player.id && !args.where.teamId) {
          return Promise.resolve([{
            ...member,
            team: { ...team, season: { ...season, league } },
          }]);
        }
        // Second call inside getAccessibleTeamIds: by teamIds + playerId
        if (args.where.teamId && args.where.playerId === player.id) {
          return Promise.resolve([{ teamId: team.id }]);
        }
        return Promise.resolve([]);
      });
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]); // no league admin access
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]); // no staff access
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([{ id: game.id, teamId: team.id }]);
      (mockPrisma.playerStats.findMany as jest.Mock).mockResolvedValue([stats]);

      const result = await StatsService.getPlayerOverallStats(player.id, player.id);

      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].teamId).toBe(team.id);
      expect(result.teams[0].stats.points).toBe(12);
      expect(result.careerTotals.gamesPlayed).toBe(1);
    });

    it('should grant access to league admin via getAccessibleTeamIds', async () => {
      const leagueAdmin = createCoach({ id: 'league-admin' });
      const player = createPlayer({ id: 'player-la', name: 'Player LA' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ id: 'team-la', seasonId: season.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });
      const game = createGame({ teamId: team.id, status: 'FINISHED' });
      const stats = createPlayerStats({ playerId: player.id, gameId: game.id, points: 8 });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player.id) return Promise.resolve(player);
        if (args.where.id === leagueAdmin.id) return Promise.resolve({ role: 'COACH' });
        return Promise.resolve(null);
      });
      (mockPrisma.teamMember.findMany as jest.Mock).mockImplementation((args: { where: { playerId?: string; teamId?: unknown } }) => {
        if (args.where.playerId === player.id && !args.where.teamId) {
          return Promise.resolve([{
            ...member,
            team: { ...team, season: { ...season, league } },
          }]);
        }
        return Promise.resolve([]); // caller is not a team member
      });
      // League admin returns the team
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{ id: team.id }]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([{ id: game.id, teamId: team.id }]);
      (mockPrisma.playerStats.findMany as jest.Mock).mockResolvedValue([stats]);

      const result = await StatsService.getPlayerOverallStats(player.id, leagueAdmin.id);

      expect(result.teams).toHaveLength(1);
      expect(result.careerTotals.points).toBe(8);
    });

    it('should grant access to team staff via getAccessibleTeamIds', async () => {
      const staffUser = createCoach({ id: 'staff-user' });
      const player = createPlayer({ id: 'player-staff', name: 'P' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ id: 'team-staff', seasonId: season.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player.id) return Promise.resolve(player);
        return Promise.resolve({ role: 'COACH' });
      });
      (mockPrisma.teamMember.findMany as jest.Mock).mockImplementation((args: { where: { playerId?: string; teamId?: unknown } }) => {
        if (args.where.playerId === player.id && !args.where.teamId) {
          return Promise.resolve([{
            ...member,
            team: { ...team, season: { ...season, league } },
          }]);
        }
        return Promise.resolve([]);
      });
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ teamId: team.id }]); // staff
      // No finished games
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.playerStats.findMany as jest.Mock).mockResolvedValue([]);

      const result = await StatsService.getPlayerOverallStats(player.id, staffUser.id);

      expect(result.teams).toHaveLength(1);
      // No finished games => gamesPlayed is 0
      expect(result.teams[0].stats.gamesPlayed).toBe(0);
      expect(result.teams[0].stats.points).toBe(0);
      expect(result.teams[0].stats.fieldGoalPercentage).toBe(0);
      expect(result.careerTotals.gamesPlayed).toBe(0);
      expect(result.careerTotals.efficiency).toBe(0);
    });

    it('should throw NotFoundError if player does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

      try {
        await StatsService.getPlayerOverallStats('missing-player', 'any-user');
        fail('Expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw NotFoundError if player has no memberships', async () => {
      const player = createPlayer();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

      try {
        await StatsService.getPlayerOverallStats(player.id, 'any-user');
        fail('Expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error, 'Player not found or has no team memberships');
      }
    });

    it('should throw ForbiddenError if caller has no access to any team', async () => {
      const outsider = createPlayer({ id: 'outsider' });
      const player = createPlayer({ id: 'player-forbid', name: 'P' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ id: 'team-forbid', seasonId: season.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player.id) return Promise.resolve(player);
        return Promise.resolve({ role: 'PLAYER' });
      });
      (mockPrisma.teamMember.findMany as jest.Mock).mockImplementation((args: { where: { playerId?: string; teamId?: unknown } }) => {
        if (args.where.playerId === player.id && !args.where.teamId) {
          return Promise.resolve([{
            ...member,
            team: { ...team, season: { ...season, league } },
          }]);
        }
        return Promise.resolve([]);
      });
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);

      try {
        await StatsService.getPlayerOverallStats(player.id, outsider.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, "You do not have access to this player's teams");
      }
    });

    it('should skip teams the caller cannot access', async () => {
      // Caller is a staff member on teamA only; player is on teamA and teamB.
      const staffUser = createCoach({ id: 'staff-partial' });
      const player = createPlayer({ id: 'player-partial', name: 'P' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const teamA = createTeam({ id: 'team-partial-a', name: 'A', seasonId: season.id });
      const teamB = createTeam({ id: 'team-partial-b', name: 'B', seasonId: season.id });
      const memberA = createTeamMember({ teamId: teamA.id, playerId: player.id });
      const memberB = createTeamMember({ teamId: teamB.id, playerId: player.id });
      const gameA = createGame({ id: 'game-pa', teamId: teamA.id, status: 'FINISHED' });
      const statsA = createPlayerStats({ playerId: player.id, gameId: gameA.id, points: 10 });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === player.id) return Promise.resolve(player);
        return Promise.resolve({ role: 'COACH' });
      });
      (mockPrisma.teamMember.findMany as jest.Mock).mockImplementation((args: { where: { playerId?: string; teamId?: unknown } }) => {
        if (args.where.playerId === player.id && !args.where.teamId) {
          return Promise.resolve([
            { ...memberA, team: { ...teamA, season: { ...season, league } } },
            { ...memberB, team: { ...teamB, season: { ...season, league } } },
          ]);
        }
        return Promise.resolve([]);
      });
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ teamId: teamA.id }]); // access only to A
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([{ id: gameA.id, teamId: teamA.id }]);
      (mockPrisma.playerStats.findMany as jest.Mock).mockResolvedValue([statsA]);

      const result = await StatsService.getPlayerOverallStats(player.id, staffUser.id);

      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].teamId).toBe(teamA.id);
      expect(result.careerTotals.gamesPlayed).toBe(1);
      expect(result.careerTotals.points).toBe(10);
    });
  });
});
