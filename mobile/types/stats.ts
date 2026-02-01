/**
 * Stats type definitions
 */

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

export interface PlayerOverallStats {
  player: {
    id: string;
    name: string;
  };
  teams: Array<{
    teamId: string;
    teamName: string;
    seasonName: string;
    stats: AggregatedPlayerStats;
  }>;
  careerTotals: AggregatedPlayerStats;
}
