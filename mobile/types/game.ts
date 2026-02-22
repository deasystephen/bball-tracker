/**
 * Game and GameEvent type definitions
 */

export type GameStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED';

export type GameEventType =
  | 'SHOT'
  | 'REBOUND'
  | 'ASSIST'
  | 'TURNOVER'
  | 'FOUL'
  | 'SUBSTITUTION'
  | 'STEAL'
  | 'BLOCK'
  | 'TIMEOUT';

export interface Game {
  id: string;
  teamId: string;
  opponent: string;
  date: string;
  status: GameStatus;
  homeScore: number;
  awayScore: number;
  createdAt: string;
  updatedAt: string;
  team?: {
    id: string;
    name: string;
    members?: Array<{
      id: string;
      playerId: string;
      jerseyNumber?: number;
      position?: string;
      player: {
        id: string;
        name: string;
        email: string;
      };
    }>;
  };
}

export interface ShotMetadata {
  made: boolean;
  points: 2 | 3;
}

export interface ReboundMetadata {
  type: 'offensive' | 'defensive';
}

export type GameEventMetadata = ShotMetadata | ReboundMetadata | Record<string, unknown>;

export interface GameEvent {
  id: string;
  gameId: string;
  playerId?: string;
  eventType: GameEventType;
  timestamp: string;
  metadata: ShotMetadata | Record<string, unknown>;
  createdAt: string;
  player?: {
    id: string;
    name: string;
  };
}

export interface CreateGameInput {
  teamId: string;
  opponent: string;
  date: string;
  status?: GameStatus;
}

export interface UpdateGameInput {
  opponent?: string;
  date?: string;
  status?: GameStatus;
  homeScore?: number;
  awayScore?: number;
}

export interface CreateGameEventInput {
  playerId?: string;
  eventType: GameEventType;
  timestamp?: string;
  metadata?: ShotMetadata | Record<string, unknown>;
}

export interface GameFilters {
  teamId?: string;
  status?: GameStatus;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export interface GameEventFilters {
  eventType?: GameEventType;
  playerId?: string;
  limit?: number;
  offset?: number;
}

// RSVP types
export type RsvpStatus = 'YES' | 'NO' | 'MAYBE';

export interface GameRsvp {
  id: string;
  gameId: string;
  userId: string;
  status: RsvpStatus;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    name: string;
    email?: string;
  };
}

export interface RsvpSummary {
  yes: number;
  no: number;
  maybe: number;
}
