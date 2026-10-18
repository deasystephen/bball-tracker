import type { GameResult } from '../utils/game-result';

/**
 * Stats type definitions
 */

export interface PlayerGameStats {
  playerId: string;
  playerName: string;
  /** Tombstone state for `playerName` (#813); render via `playerDisplayName`. */
  playerDeletedAt: string | null;
  /**
   * `0` is a valid jersey: test `!= null`, never truthiness or `!== undefined`.
   * The stats service omits the key for a player without a number today;
   * `null` is typed so a backend that sends it cannot render "#null".
   */
  jerseyNumber?: number | null;
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
  /** FINISHED games (wins + losses + ties). */
  gamesPlayed: number;
  /** FINISHED games with a finalized box score; the divisor for per-game averages. */
  trackedGames: number;
  wins: number;
  losses: number;
  ties: number;
  pointsPerGame: number;
  reboundsPerGame: number;
  assistsPerGame: number;
  turnoversPerGame: number;
  fieldGoalPercentage: number;
  threePointPercentage: number;
  freeThrowPercentage: number;
  recentGames: {
    id: string;
    date: string;
    opponent: string;
    homeScore: number;
    awayScore: number;
    result: GameResult;
  }[];
}

export interface PlayerOverallStats {
  player: {
    id: string;
    name: string;
    isManaged: boolean;
    /** Set when the account was deleted; render via `displayName`. */
    deletedAt: string | null;
  };
  teams: {
    teamId: string;
    teamName: string;
    seasonName: string;
    stats: AggregatedPlayerStats;
  }[];
  careerTotals: AggregatedPlayerStats;
}
