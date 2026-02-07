/**
 * Stats service layer for calculating and retrieving game/player/team statistics
 */

import prisma from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { canAccessTeam } from '../utils/permissions';
import { GameEventType } from '@prisma/client';

// Types for stats responses
export interface PlayerGameStats {
  playerId: string;
  playerName: string;
  jerseyNumber?: number;
  position?: string;
  points: number;
  rebounds: number;
  offensiveRebounds: number;
  defensiveRebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fouls: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  fieldGoalPercentage: number;
  threePointersMade: number;
  threePointersAttempted: number;
  threePointPercentage: number;
  freeThrowsMade: number;
  freeThrowsAttempted: number;
  freeThrowPercentage: number;
}

export interface AggregatedPlayerStats extends PlayerGameStats {
  gamesPlayed: number;
  pointsPerGame: number;
  reboundsPerGame: number;
  assistsPerGame: number;
  stealsPerGame: number;
  blocksPerGame: number;
  turnoversPerGame: number;
  efficiency: number;
}

export interface TeamGameStats {
  teamId: string;
  teamName: string;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fouls: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  fieldGoalPercentage: number;
  threePointersMade: number;
  threePointersAttempted: number;
  threePointPercentage: number;
  freeThrowsMade: number;
  freeThrowsAttempted: number;
  freeThrowPercentage: number;
}

export interface BoxScore {
  game: {
    id: string;
    date: string;
    status: string;
    homeScore: number;
    awayScore: number;
    opponent: string;
  };
  team: {
    id: string;
    name: string;
    stats: TeamGameStats;
    players: PlayerGameStats[];
  };
}

export interface TeamSeasonStats {
  teamId: string;
  teamName: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsPerGame: number;
  reboundsPerGame: number;
  assistsPerGame: number;
  turnoversPerGame: number;
  fieldGoalPercentage: number;
  threePointPercentage: number;
  freeThrowPercentage: number;
  recentGames: Array<{
    id: string;
    date: string;
    opponent: string;
    homeScore: number;
    awayScore: number;
    result: 'W' | 'L';
  }>;
}

interface ShotMetadata {
  made: boolean;
  points: number;
}

interface ReboundMetadata {
  type: 'offensive' | 'defensive';
}

export class StatsService {
  /**
   * Calculate player stats from game events for a specific game
   */
  static async calculatePlayerStats(gameId: string): Promise<PlayerGameStats[]> {
    // Fetch events and game with members in parallel
    const [events, game] = await Promise.all([
      prisma.gameEvent.findMany({
        where: { gameId },
        include: {
          player: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.game.findUnique({
        where: { id: gameId },
        include: {
          team: {
            include: {
              members: {
                select: {
                  playerId: true,
                  jerseyNumber: true,
                  position: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const memberMap = new Map(
      game.team.members.map((m) => [
        m.playerId,
        { jerseyNumber: m.jerseyNumber, position: m.position },
      ])
    );

    // Group events by player
    const playerStatsMap = new Map<string, PlayerGameStats>();

    for (const event of events) {
      if (!event.playerId || !event.player) continue;

      if (!playerStatsMap.has(event.playerId)) {
        const memberInfo = memberMap.get(event.playerId);
        playerStatsMap.set(event.playerId, {
          playerId: event.playerId,
          playerName: event.player.name,
          jerseyNumber: memberInfo?.jerseyNumber ?? undefined,
          position: memberInfo?.position ?? undefined,
          points: 0,
          rebounds: 0,
          offensiveRebounds: 0,
          defensiveRebounds: 0,
          assists: 0,
          steals: 0,
          blocks: 0,
          turnovers: 0,
          fouls: 0,
          fieldGoalsMade: 0,
          fieldGoalsAttempted: 0,
          fieldGoalPercentage: 0,
          threePointersMade: 0,
          threePointersAttempted: 0,
          threePointPercentage: 0,
          freeThrowsMade: 0,
          freeThrowsAttempted: 0,
          freeThrowPercentage: 0,
        });
      }

      const stats = playerStatsMap.get(event.playerId)!;
      const metadata = event.metadata as Record<string, unknown>;

      switch (event.eventType) {
        case GameEventType.SHOT: {
          const shotMeta = metadata as unknown as ShotMetadata;
          const pointValue = shotMeta.points || 2;

          if (pointValue === 3) {
            stats.threePointersAttempted++;
            if (shotMeta.made) {
              stats.threePointersMade++;
              stats.points += 3;
            }
          } else if (pointValue === 1) {
            // Free throw
            stats.freeThrowsAttempted++;
            if (shotMeta.made) {
              stats.freeThrowsMade++;
              stats.points += 1;
            }
          } else {
            // Regular 2-pointer
            stats.fieldGoalsAttempted++;
            if (shotMeta.made) {
              stats.fieldGoalsMade++;
              stats.points += 2;
            }
          }
          break;
        }
        case GameEventType.REBOUND: {
          const reboundMeta = metadata as unknown as ReboundMetadata;
          stats.rebounds++;
          if (reboundMeta.type === 'offensive') {
            stats.offensiveRebounds++;
          } else {
            stats.defensiveRebounds++;
          }
          break;
        }
        case GameEventType.ASSIST:
          stats.assists++;
          break;
        case GameEventType.STEAL:
          stats.steals++;
          break;
        case GameEventType.BLOCK:
          stats.blocks++;
          break;
        case GameEventType.TURNOVER:
          stats.turnovers++;
          break;
        case GameEventType.FOUL:
          stats.fouls++;
          break;
      }
    }

    // Calculate percentages
    for (const stats of playerStatsMap.values()) {
      // Field goals include 2-pointers and 3-pointers
      const totalFGAttempted = stats.fieldGoalsAttempted + stats.threePointersAttempted;
      const totalFGMade = stats.fieldGoalsMade + stats.threePointersMade;

      stats.fieldGoalsAttempted = totalFGAttempted;
      stats.fieldGoalsMade = totalFGMade;

      stats.fieldGoalPercentage = totalFGAttempted > 0
        ? Math.round((totalFGMade / totalFGAttempted) * 1000) / 10
        : 0;
      stats.threePointPercentage = stats.threePointersAttempted > 0
        ? Math.round((stats.threePointersMade / stats.threePointersAttempted) * 1000) / 10
        : 0;
      stats.freeThrowPercentage = stats.freeThrowsAttempted > 0
        ? Math.round((stats.freeThrowsMade / stats.freeThrowsAttempted) * 1000) / 10
        : 0;
    }

    return Array.from(playerStatsMap.values()).sort((a, b) => b.points - a.points);
  }

  /**
   * Calculate team totals from player stats
   */
  static calculateTeamTotals(
    teamId: string,
    teamName: string,
    playerStats: PlayerGameStats[]
  ): TeamGameStats {
    const totals: TeamGameStats = {
      teamId,
      teamName,
      points: 0,
      rebounds: 0,
      assists: 0,
      steals: 0,
      blocks: 0,
      turnovers: 0,
      fouls: 0,
      fieldGoalsMade: 0,
      fieldGoalsAttempted: 0,
      fieldGoalPercentage: 0,
      threePointersMade: 0,
      threePointersAttempted: 0,
      threePointPercentage: 0,
      freeThrowsMade: 0,
      freeThrowsAttempted: 0,
      freeThrowPercentage: 0,
    };

    for (const player of playerStats) {
      totals.points += player.points;
      totals.rebounds += player.rebounds;
      totals.assists += player.assists;
      totals.steals += player.steals;
      totals.blocks += player.blocks;
      totals.turnovers += player.turnovers;
      totals.fouls += player.fouls;
      totals.fieldGoalsMade += player.fieldGoalsMade;
      totals.fieldGoalsAttempted += player.fieldGoalsAttempted;
      totals.threePointersMade += player.threePointersMade;
      totals.threePointersAttempted += player.threePointersAttempted;
      totals.freeThrowsMade += player.freeThrowsMade;
      totals.freeThrowsAttempted += player.freeThrowsAttempted;
    }

    // Calculate percentages
    totals.fieldGoalPercentage = totals.fieldGoalsAttempted > 0
      ? Math.round((totals.fieldGoalsMade / totals.fieldGoalsAttempted) * 1000) / 10
      : 0;
    totals.threePointPercentage = totals.threePointersAttempted > 0
      ? Math.round((totals.threePointersMade / totals.threePointersAttempted) * 1000) / 10
      : 0;
    totals.freeThrowPercentage = totals.freeThrowsAttempted > 0
      ? Math.round((totals.freeThrowsMade / totals.freeThrowsAttempted) * 1000) / 10
      : 0;

    return totals;
  }

  /**
   * Finalize game stats when game status changes to FINISHED
   * This persists calculated stats to PlayerStats and TeamStats tables.
   * Uses a transaction to batch all upserts together.
   */
  static async finalizeGameStats(gameId: string): Promise<void> {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        team: true,
      },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const playerStats = await this.calculatePlayerStats(gameId);
    const teamStats = this.calculateTeamTotals(game.teamId, game.team.name, playerStats);

    // Batch all upserts in a single transaction
    await prisma.$transaction([
      // Upsert player stats
      ...playerStats.map((stats) =>
        prisma.playerStats.upsert({
          where: {
            playerId_gameId: {
              playerId: stats.playerId,
              gameId,
            },
          },
          create: {
            playerId: stats.playerId,
            gameId,
            points: stats.points,
            rebounds: stats.rebounds,
            assists: stats.assists,
            steals: stats.steals,
            blocks: stats.blocks,
            turnovers: stats.turnovers,
            fouls: stats.fouls,
            fieldGoalsMade: stats.fieldGoalsMade,
            fieldGoalsAttempted: stats.fieldGoalsAttempted,
            threePointersMade: stats.threePointersMade,
            threePointersAttempted: stats.threePointersAttempted,
            freeThrowsMade: stats.freeThrowsMade,
            freeThrowsAttempted: stats.freeThrowsAttempted,
          },
          update: {
            points: stats.points,
            rebounds: stats.rebounds,
            assists: stats.assists,
            steals: stats.steals,
            blocks: stats.blocks,
            turnovers: stats.turnovers,
            fouls: stats.fouls,
            fieldGoalsMade: stats.fieldGoalsMade,
            fieldGoalsAttempted: stats.fieldGoalsAttempted,
            threePointersMade: stats.threePointersMade,
            threePointersAttempted: stats.threePointersAttempted,
            freeThrowsMade: stats.freeThrowsMade,
            freeThrowsAttempted: stats.freeThrowsAttempted,
          },
        })
      ),
      // Upsert team stats
      prisma.teamStats.upsert({
        where: {
          teamId_gameId: {
            teamId: game.teamId,
            gameId,
          },
        },
        create: {
          teamId: game.teamId,
          gameId,
          points: teamStats.points,
          rebounds: teamStats.rebounds,
          assists: teamStats.assists,
          turnovers: teamStats.turnovers,
          fieldGoalPercentage: teamStats.fieldGoalPercentage,
          threePointPercentage: teamStats.threePointPercentage,
          freeThrowPercentage: teamStats.freeThrowPercentage,
        },
        update: {
          points: teamStats.points,
          rebounds: teamStats.rebounds,
          assists: teamStats.assists,
          turnovers: teamStats.turnovers,
          fieldGoalPercentage: teamStats.fieldGoalPercentage,
          threePointPercentage: teamStats.threePointPercentage,
          freeThrowPercentage: teamStats.freeThrowPercentage,
        },
      }),
    ]);
  }

  /**
   * Get box score for a game (live calculation from events)
   */
  static async getBoxScore(gameId: string, userId: string): Promise<BoxScore> {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        team: true,
      },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    // Check access
    const hasAccess = await canAccessTeam(userId, game.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this game');
    }

    const playerStats = await this.calculatePlayerStats(gameId);
    const teamStats = this.calculateTeamTotals(game.teamId, game.team.name, playerStats);

    return {
      game: {
        id: game.id,
        date: game.date.toISOString(),
        status: game.status,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        opponent: game.opponent,
      },
      team: {
        id: game.team.id,
        name: game.team.name,
        stats: teamStats,
        players: playerStats,
      },
    };
  }

  /**
   * Get player's game stats for a specific game
   */
  static async getPlayerGameStats(
    gameId: string,
    playerId: string,
    userId: string
  ): Promise<PlayerGameStats> {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const hasAccess = await canAccessTeam(userId, game.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this game');
    }

    const allStats = await this.calculatePlayerStats(gameId);
    const playerStats = allStats.find((s) => s.playerId === playerId);

    if (!playerStats) {
      throw new NotFoundError('Player stats not found for this game');
    }

    return playerStats;
  }

  /**
   * Get player's season stats for a specific team
   */
  static async getPlayerSeasonStats(
    playerId: string,
    teamId: string,
    userId: string
  ): Promise<AggregatedPlayerStats> {
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    // Get all finished games for this team
    const games = await prisma.game.findMany({
      where: {
        teamId,
        status: 'FINISHED',
      },
      select: { id: true },
    });

    const gameIds = games.map((g) => g.id);

    // Get player stats from stored stats
    const stats = await prisma.playerStats.findMany({
      where: {
        playerId,
        gameId: { in: gameIds },
      },
    });

    // Get player info
    const player = await prisma.user.findUnique({
      where: { id: playerId },
      select: { id: true, name: true },
    });

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    // Get team member info
    const teamMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: { teamId, playerId },
      },
    });

    const gamesPlayed = stats.length;

    // Aggregate stats
    const totals = {
      points: 0,
      rebounds: 0,
      assists: 0,
      steals: 0,
      blocks: 0,
      turnovers: 0,
      fouls: 0,
      fieldGoalsMade: 0,
      fieldGoalsAttempted: 0,
      threePointersMade: 0,
      threePointersAttempted: 0,
      freeThrowsMade: 0,
      freeThrowsAttempted: 0,
    };

    for (const stat of stats) {
      totals.points += stat.points;
      totals.rebounds += stat.rebounds;
      totals.assists += stat.assists;
      totals.steals += stat.steals;
      totals.blocks += stat.blocks;
      totals.turnovers += stat.turnovers;
      totals.fouls += stat.fouls;
      totals.fieldGoalsMade += stat.fieldGoalsMade;
      totals.fieldGoalsAttempted += stat.fieldGoalsAttempted;
      totals.threePointersMade += stat.threePointersMade;
      totals.threePointersAttempted += stat.threePointersAttempted;
      totals.freeThrowsMade += stat.freeThrowsMade;
      totals.freeThrowsAttempted += stat.freeThrowsAttempted;
    }

    // Calculate percentages
    const fieldGoalPercentage = totals.fieldGoalsAttempted > 0
      ? Math.round((totals.fieldGoalsMade / totals.fieldGoalsAttempted) * 1000) / 10
      : 0;
    const threePointPercentage = totals.threePointersAttempted > 0
      ? Math.round((totals.threePointersMade / totals.threePointersAttempted) * 1000) / 10
      : 0;
    const freeThrowPercentage = totals.freeThrowsAttempted > 0
      ? Math.round((totals.freeThrowsMade / totals.freeThrowsAttempted) * 1000) / 10
      : 0;

    // Calculate per-game averages
    const ppg = gamesPlayed > 0 ? Math.round((totals.points / gamesPlayed) * 10) / 10 : 0;
    const rpg = gamesPlayed > 0 ? Math.round((totals.rebounds / gamesPlayed) * 10) / 10 : 0;
    const apg = gamesPlayed > 0 ? Math.round((totals.assists / gamesPlayed) * 10) / 10 : 0;
    const spg = gamesPlayed > 0 ? Math.round((totals.steals / gamesPlayed) * 10) / 10 : 0;
    const bpg = gamesPlayed > 0 ? Math.round((totals.blocks / gamesPlayed) * 10) / 10 : 0;
    const tpg = gamesPlayed > 0 ? Math.round((totals.turnovers / gamesPlayed) * 10) / 10 : 0;

    // Calculate efficiency
    // EFF = (PTS + REB + AST + STL + BLK - Missed FG - Missed FT - TO) / Games
    const missedFG = totals.fieldGoalsAttempted - totals.fieldGoalsMade;
    const missedFT = totals.freeThrowsAttempted - totals.freeThrowsMade;
    const efficiency = gamesPlayed > 0
      ? Math.round(
          ((totals.points + totals.rebounds + totals.assists + totals.steals + totals.blocks -
            missedFG - missedFT - totals.turnovers) / gamesPlayed) * 10
        ) / 10
      : 0;

    return {
      playerId: player.id,
      playerName: player.name,
      jerseyNumber: teamMember?.jerseyNumber ?? undefined,
      position: teamMember?.position ?? undefined,
      ...totals,
      offensiveRebounds: 0, // Not tracked in PlayerStats table
      defensiveRebounds: 0,
      fieldGoalPercentage,
      threePointPercentage,
      freeThrowPercentage,
      gamesPlayed,
      pointsPerGame: ppg,
      reboundsPerGame: rpg,
      assistsPerGame: apg,
      stealsPerGame: spg,
      blocksPerGame: bpg,
      turnoversPerGame: tpg,
      efficiency,
    };
  }

  /**
   * Get team's season stats
   */
  static async getTeamSeasonStats(
    teamId: string,
    userId: string
  ): Promise<TeamSeasonStats> {
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    // Get team and finished games in parallel
    const [team, games] = await Promise.all([
      prisma.team.findUnique({
        where: { id: teamId },
      }),
      prisma.game.findMany({
        where: {
          teamId,
          status: 'FINISHED',
        },
        orderBy: { date: 'desc' },
      }),
    ]);

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Get team stats for all games
    const teamStats = games.length > 0
      ? await prisma.teamStats.findMany({
          where: {
            teamId,
            gameId: { in: games.map((g) => g.id) },
          },
        })
      : [];

    const gamesPlayed = games.length;
    let wins = 0;
    let losses = 0;

    const recentGames = games.slice(0, 10).map((game) => {
      const isWin = game.homeScore > game.awayScore;
      if (isWin) wins++;
      else losses++;

      return {
        id: game.id,
        date: game.date.toISOString(),
        opponent: game.opponent,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        result: isWin ? 'W' as const : 'L' as const,
      };
    });

    // Count remaining games for win/loss record
    for (let i = 10; i < games.length; i++) {
      if (games[i].homeScore > games[i].awayScore) wins++;
      else losses++;
    }

    // Aggregate stats
    const totals = {
      points: 0,
      rebounds: 0,
      assists: 0,
      turnovers: 0,
      fieldGoalPercentage: 0,
      threePointPercentage: 0,
      freeThrowPercentage: 0,
    };

    for (const stat of teamStats) {
      totals.points += stat.points;
      totals.rebounds += stat.rebounds;
      totals.assists += stat.assists;
      totals.turnovers += stat.turnovers;
      totals.fieldGoalPercentage += stat.fieldGoalPercentage;
      totals.threePointPercentage += stat.threePointPercentage;
      totals.freeThrowPercentage += stat.freeThrowPercentage;
    }

    return {
      teamId,
      teamName: team.name,
      gamesPlayed,
      wins,
      losses,
      pointsPerGame: gamesPlayed > 0 ? Math.round((totals.points / gamesPlayed) * 10) / 10 : 0,
      reboundsPerGame: gamesPlayed > 0 ? Math.round((totals.rebounds / gamesPlayed) * 10) / 10 : 0,
      assistsPerGame: gamesPlayed > 0 ? Math.round((totals.assists / gamesPlayed) * 10) / 10 : 0,
      turnoversPerGame: gamesPlayed > 0 ? Math.round((totals.turnovers / gamesPlayed) * 10) / 10 : 0,
      fieldGoalPercentage: gamesPlayed > 0
        ? Math.round((totals.fieldGoalPercentage / gamesPlayed) * 10) / 10
        : 0,
      threePointPercentage: gamesPlayed > 0
        ? Math.round((totals.threePointPercentage / gamesPlayed) * 10) / 10
        : 0,
      freeThrowPercentage: gamesPlayed > 0
        ? Math.round((totals.freeThrowPercentage / gamesPlayed) * 10) / 10
        : 0,
      recentGames,
    };
  }

  /**
   * Get roster with season stats for all players on a team
   * Optimized to batch-load stats instead of N+1 queries per player
   */
  static async getTeamRosterStats(
    teamId: string,
    userId: string
  ): Promise<AggregatedPlayerStats[]> {
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    // Get team members and finished game IDs in parallel
    const [members, finishedGames] = await Promise.all([
      prisma.teamMember.findMany({
        where: { teamId },
        include: {
          player: {
            select: { id: true, name: true },
          },
        },
      }),
      prisma.game.findMany({
        where: { teamId, status: 'FINISHED' },
        select: { id: true },
      }),
    ]);

    const gameIds = finishedGames.map((g) => g.id);
    const playerIds = members.map((m) => m.playerId);

    // Batch-load all player stats for all team members at once
    const allStats = gameIds.length > 0 && playerIds.length > 0
      ? await prisma.playerStats.findMany({
          where: {
            playerId: { in: playerIds },
            gameId: { in: gameIds },
          },
        })
      : [];

    // Group stats by player
    const statsByPlayer = new Map<string, typeof allStats>();
    for (const stat of allStats) {
      const existing = statsByPlayer.get(stat.playerId) || [];
      existing.push(stat);
      statsByPlayer.set(stat.playerId, existing);
    }

    // Build aggregated stats for each member
    const playerStatsResult: AggregatedPlayerStats[] = members.map((member) => {
      const stats = statsByPlayer.get(member.playerId) || [];
      const gamesPlayed = stats.length;

      const totals = {
        points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0,
        turnovers: 0, fouls: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0,
        threePointersMade: 0, threePointersAttempted: 0,
        freeThrowsMade: 0, freeThrowsAttempted: 0,
      };

      for (const stat of stats) {
        totals.points += stat.points;
        totals.rebounds += stat.rebounds;
        totals.assists += stat.assists;
        totals.steals += stat.steals;
        totals.blocks += stat.blocks;
        totals.turnovers += stat.turnovers;
        totals.fouls += stat.fouls;
        totals.fieldGoalsMade += stat.fieldGoalsMade;
        totals.fieldGoalsAttempted += stat.fieldGoalsAttempted;
        totals.threePointersMade += stat.threePointersMade;
        totals.threePointersAttempted += stat.threePointersAttempted;
        totals.freeThrowsMade += stat.freeThrowsMade;
        totals.freeThrowsAttempted += stat.freeThrowsAttempted;
      }

      const fieldGoalPercentage = totals.fieldGoalsAttempted > 0
        ? Math.round((totals.fieldGoalsMade / totals.fieldGoalsAttempted) * 1000) / 10 : 0;
      const threePointPercentage = totals.threePointersAttempted > 0
        ? Math.round((totals.threePointersMade / totals.threePointersAttempted) * 1000) / 10 : 0;
      const freeThrowPercentage = totals.freeThrowsAttempted > 0
        ? Math.round((totals.freeThrowsMade / totals.freeThrowsAttempted) * 1000) / 10 : 0;

      const ppg = gamesPlayed > 0 ? Math.round((totals.points / gamesPlayed) * 10) / 10 : 0;
      const rpg = gamesPlayed > 0 ? Math.round((totals.rebounds / gamesPlayed) * 10) / 10 : 0;
      const apg = gamesPlayed > 0 ? Math.round((totals.assists / gamesPlayed) * 10) / 10 : 0;
      const spg = gamesPlayed > 0 ? Math.round((totals.steals / gamesPlayed) * 10) / 10 : 0;
      const bpg = gamesPlayed > 0 ? Math.round((totals.blocks / gamesPlayed) * 10) / 10 : 0;
      const tpg = gamesPlayed > 0 ? Math.round((totals.turnovers / gamesPlayed) * 10) / 10 : 0;

      const missedFG = totals.fieldGoalsAttempted - totals.fieldGoalsMade;
      const missedFT = totals.freeThrowsAttempted - totals.freeThrowsMade;
      const efficiency = gamesPlayed > 0
        ? Math.round(
            ((totals.points + totals.rebounds + totals.assists + totals.steals + totals.blocks -
              missedFG - missedFT - totals.turnovers) / gamesPlayed) * 10
          ) / 10
        : 0;

      return {
        playerId: member.playerId,
        playerName: member.player.name,
        jerseyNumber: member.jerseyNumber ?? undefined,
        position: member.position ?? undefined,
        ...totals,
        offensiveRebounds: 0,
        defensiveRebounds: 0,
        fieldGoalPercentage,
        threePointPercentage,
        freeThrowPercentage,
        gamesPlayed,
        pointsPerGame: ppg,
        reboundsPerGame: rpg,
        assistsPerGame: apg,
        stealsPerGame: spg,
        blocksPerGame: bpg,
        turnoversPerGame: tpg,
        efficiency,
      };
    });

    // Sort by points per game
    return playerStatsResult.sort((a, b) => b.pointsPerGame - a.pointsPerGame);
  }

  /**
   * Get overall player stats across all teams
   * Optimized to batch-check access and batch-load stats
   */
  static async getPlayerOverallStats(
    playerId: string,
    userId: string
  ): Promise<{
    player: { id: string; name: string };
    teams: Array<{
      teamId: string;
      teamName: string;
      seasonName: string;
      stats: AggregatedPlayerStats;
    }>;
    careerTotals: AggregatedPlayerStats;
  }> {
    // Get player info and memberships in parallel
    const [player, memberships] = await Promise.all([
      prisma.user.findUnique({
        where: { id: playerId },
        select: { id: true, name: true },
      }),
      prisma.teamMember.findMany({
        where: { playerId },
        include: {
          team: {
            include: {
              season: {
                include: {
                  league: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    if (memberships.length === 0) {
      throw new NotFoundError('Player not found or has no team memberships');
    }

    // Check access to teams - batch check by finding user's accessible teams
    const teamIds = memberships.map((m) => m.teamId);
    const accessibleTeamIds = await this.getAccessibleTeamIds(userId, teamIds);

    if (accessibleTeamIds.size === 0) {
      throw new ForbiddenError('You do not have access to this player\'s teams');
    }

    // Get all finished games for accessible teams
    const finishedGames = await prisma.game.findMany({
      where: {
        teamId: { in: Array.from(accessibleTeamIds) },
        status: 'FINISHED',
      },
      select: { id: true, teamId: true },
    });

    // Group game IDs by team
    const gameIdsByTeam = new Map<string, string[]>();
    for (const game of finishedGames) {
      const existing = gameIdsByTeam.get(game.teamId) || [];
      existing.push(game.id);
      gameIdsByTeam.set(game.teamId, existing);
    }

    // Batch-load all player stats at once
    const allGameIds = finishedGames.map((g) => g.id);
    const allPlayerStats = allGameIds.length > 0
      ? await prisma.playerStats.findMany({
          where: {
            playerId,
            gameId: { in: allGameIds },
          },
        })
      : [];

    // Group stats by gameId for quick lookup
    const statsByGameId = new Map<string, typeof allPlayerStats[0]>();
    for (const stat of allPlayerStats) {
      statsByGameId.set(stat.gameId, stat);
    }

    const teamStatsResult: Array<{
      teamId: string;
      teamName: string;
      seasonName: string;
      stats: AggregatedPlayerStats;
    }> = [];

    // Build stats per accessible team
    for (const membership of memberships) {
      if (!accessibleTeamIds.has(membership.teamId)) continue;

      const teamGameIds = gameIdsByTeam.get(membership.teamId) || [];
      const stats = teamGameIds
        .map((gid) => statsByGameId.get(gid))
        .filter((s): s is NonNullable<typeof s> => s != null);

      const gamesPlayed = stats.length;
      const totals = {
        points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0,
        turnovers: 0, fouls: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0,
        threePointersMade: 0, threePointersAttempted: 0,
        freeThrowsMade: 0, freeThrowsAttempted: 0,
      };

      for (const stat of stats) {
        totals.points += stat.points;
        totals.rebounds += stat.rebounds;
        totals.assists += stat.assists;
        totals.steals += stat.steals;
        totals.blocks += stat.blocks;
        totals.turnovers += stat.turnovers;
        totals.fouls += stat.fouls;
        totals.fieldGoalsMade += stat.fieldGoalsMade;
        totals.fieldGoalsAttempted += stat.fieldGoalsAttempted;
        totals.threePointersMade += stat.threePointersMade;
        totals.threePointersAttempted += stat.threePointersAttempted;
        totals.freeThrowsMade += stat.freeThrowsMade;
        totals.freeThrowsAttempted += stat.freeThrowsAttempted;
      }

      const fieldGoalPercentage = totals.fieldGoalsAttempted > 0
        ? Math.round((totals.fieldGoalsMade / totals.fieldGoalsAttempted) * 1000) / 10 : 0;
      const threePointPercentage = totals.threePointersAttempted > 0
        ? Math.round((totals.threePointersMade / totals.threePointersAttempted) * 1000) / 10 : 0;
      const freeThrowPercentage = totals.freeThrowsAttempted > 0
        ? Math.round((totals.freeThrowsMade / totals.freeThrowsAttempted) * 1000) / 10 : 0;

      const ppg = gamesPlayed > 0 ? Math.round((totals.points / gamesPlayed) * 10) / 10 : 0;
      const rpg = gamesPlayed > 0 ? Math.round((totals.rebounds / gamesPlayed) * 10) / 10 : 0;
      const apg = gamesPlayed > 0 ? Math.round((totals.assists / gamesPlayed) * 10) / 10 : 0;
      const spg = gamesPlayed > 0 ? Math.round((totals.steals / gamesPlayed) * 10) / 10 : 0;
      const bpg = gamesPlayed > 0 ? Math.round((totals.blocks / gamesPlayed) * 10) / 10 : 0;
      const tpg = gamesPlayed > 0 ? Math.round((totals.turnovers / gamesPlayed) * 10) / 10 : 0;

      const missedFG = totals.fieldGoalsAttempted - totals.fieldGoalsMade;
      const missedFT = totals.freeThrowsAttempted - totals.freeThrowsMade;
      const efficiency = gamesPlayed > 0
        ? Math.round(
            ((totals.points + totals.rebounds + totals.assists + totals.steals + totals.blocks -
              missedFG - missedFT - totals.turnovers) / gamesPlayed) * 10
          ) / 10
        : 0;

      teamStatsResult.push({
        teamId: membership.teamId,
        teamName: membership.team.name,
        seasonName: `${membership.team.season.league.name} - ${membership.team.season.name}`,
        stats: {
          playerId: player.id,
          playerName: player.name,
          jerseyNumber: membership.jerseyNumber ?? undefined,
          position: membership.position ?? undefined,
          ...totals,
          offensiveRebounds: 0,
          defensiveRebounds: 0,
          fieldGoalPercentage,
          threePointPercentage,
          freeThrowPercentage,
          gamesPlayed,
          pointsPerGame: ppg,
          reboundsPerGame: rpg,
          assistsPerGame: apg,
          stealsPerGame: spg,
          blocksPerGame: bpg,
          turnoversPerGame: tpg,
          efficiency,
        },
      });
    }

    // Calculate career totals
    const careerTotals = this.aggregatePlayerStats(player, teamStatsResult.map((t) => t.stats));

    return {
      player,
      teams: teamStatsResult,
      careerTotals,
    };
  }

  /**
   * Batch-check which team IDs a user can access.
   * Returns a Set of accessible teamIds.
   */
  private static async getAccessibleTeamIds(
    userId: string,
    teamIds: string[]
  ): Promise<Set<string>> {
    // Check if system admin (can access all)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (user?.role === 'ADMIN') {
      return new Set(teamIds);
    }

    // Check league admin access, staff membership, and player membership in parallel
    const [leagueAdminTeams, staffTeams, memberTeams] = await Promise.all([
      // Teams where user is a league admin
      prisma.team.findMany({
        where: {
          id: { in: teamIds },
          season: {
            league: {
              admins: { some: { userId } },
            },
          },
        },
        select: { id: true },
      }),
      // Teams where user is staff
      prisma.teamStaff.findMany({
        where: {
          teamId: { in: teamIds },
          userId,
        },
        select: { teamId: true },
      }),
      // Teams where user is a player member
      prisma.teamMember.findMany({
        where: {
          teamId: { in: teamIds },
          playerId: userId,
        },
        select: { teamId: true },
      }),
    ]);

    const accessible = new Set<string>();
    for (const t of leagueAdminTeams) accessible.add(t.id);
    for (const t of staffTeams) accessible.add(t.teamId);
    for (const t of memberTeams) accessible.add(t.teamId);

    return accessible;
  }

  /**
   * Aggregate multiple season stats into career totals
   */
  private static aggregatePlayerStats(
    player: { id: string; name: string },
    statsList: AggregatedPlayerStats[]
  ): AggregatedPlayerStats {
    const totals = {
      points: 0,
      rebounds: 0,
      offensiveRebounds: 0,
      defensiveRebounds: 0,
      assists: 0,
      steals: 0,
      blocks: 0,
      turnovers: 0,
      fouls: 0,
      fieldGoalsMade: 0,
      fieldGoalsAttempted: 0,
      threePointersMade: 0,
      threePointersAttempted: 0,
      freeThrowsMade: 0,
      freeThrowsAttempted: 0,
      gamesPlayed: 0,
    };

    for (const stats of statsList) {
      totals.points += stats.points;
      totals.rebounds += stats.rebounds;
      totals.assists += stats.assists;
      totals.steals += stats.steals;
      totals.blocks += stats.blocks;
      totals.turnovers += stats.turnovers;
      totals.fouls += stats.fouls;
      totals.fieldGoalsMade += stats.fieldGoalsMade;
      totals.fieldGoalsAttempted += stats.fieldGoalsAttempted;
      totals.threePointersMade += stats.threePointersMade;
      totals.threePointersAttempted += stats.threePointersAttempted;
      totals.freeThrowsMade += stats.freeThrowsMade;
      totals.freeThrowsAttempted += stats.freeThrowsAttempted;
      totals.gamesPlayed += stats.gamesPlayed;
    }

    const gamesPlayed = totals.gamesPlayed;

    // Calculate percentages
    const fieldGoalPercentage = totals.fieldGoalsAttempted > 0
      ? Math.round((totals.fieldGoalsMade / totals.fieldGoalsAttempted) * 1000) / 10
      : 0;
    const threePointPercentage = totals.threePointersAttempted > 0
      ? Math.round((totals.threePointersMade / totals.threePointersAttempted) * 1000) / 10
      : 0;
    const freeThrowPercentage = totals.freeThrowsAttempted > 0
      ? Math.round((totals.freeThrowsMade / totals.freeThrowsAttempted) * 1000) / 10
      : 0;

    // Calculate per-game averages
    const ppg = gamesPlayed > 0 ? Math.round((totals.points / gamesPlayed) * 10) / 10 : 0;
    const rpg = gamesPlayed > 0 ? Math.round((totals.rebounds / gamesPlayed) * 10) / 10 : 0;
    const apg = gamesPlayed > 0 ? Math.round((totals.assists / gamesPlayed) * 10) / 10 : 0;
    const spg = gamesPlayed > 0 ? Math.round((totals.steals / gamesPlayed) * 10) / 10 : 0;
    const bpg = gamesPlayed > 0 ? Math.round((totals.blocks / gamesPlayed) * 10) / 10 : 0;
    const tpg = gamesPlayed > 0 ? Math.round((totals.turnovers / gamesPlayed) * 10) / 10 : 0;

    // Calculate efficiency
    const missedFG = totals.fieldGoalsAttempted - totals.fieldGoalsMade;
    const missedFT = totals.freeThrowsAttempted - totals.freeThrowsMade;
    const efficiency = gamesPlayed > 0
      ? Math.round(
          ((totals.points + totals.rebounds + totals.assists + totals.steals + totals.blocks -
            missedFG - missedFT - totals.turnovers) / gamesPlayed) * 10
        ) / 10
      : 0;

    return {
      playerId: player.id,
      playerName: player.name,
      ...totals,
      fieldGoalPercentage,
      threePointPercentage,
      freeThrowPercentage,
      gamesPlayed,
      pointsPerGame: ppg,
      reboundsPerGame: rpg,
      assistsPerGame: apg,
      stealsPerGame: spg,
      blocksPerGame: bpg,
      turnoversPerGame: tpg,
      efficiency,
    };
  }
}
