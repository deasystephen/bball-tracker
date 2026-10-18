/**
 * Game and GameEvent type definitions
 */

import type { TeamStaff } from '../hooks/useTeams';

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
    /** Staff rows with role flags — drive the client-side permission gates. */
    staff?: TeamStaff[];
    season?: {
      id: string;
      name: string;
      /** Only on `GET /games/:id`; the `GET /games` list item omits it. */
      isActive?: boolean;
      league: {
        id: string;
        name: string;
      };
    };
    /** Roster, on `GET /games/:id` only (backend `GameDetailView`). */
    members?: {
      id: string;
      playerId: string;
      /** `0` is a valid jersey: test `!= null`, never truthiness. */
      jerseyNumber?: number | null;
      position?: string | null;
      player: {
        id: string;
        name: string;
        /** Present only for callers with `canManageRoster`; `null` when the user has no email. */
        email?: string | null;
        isManaged: boolean;
        /** Set when the account was deleted; render via `displayName`. */
        deletedAt: string | null;
      };
    }[];
  };
}

/** One roster row of `GET /games/:id` (the tracker's player chips). */
export type GameRosterMember = NonNullable<NonNullable<Game['team']>['members']>[number];

export interface ShotMetadata {
  made: boolean;
  /** 1 = free throw, 2 = field goal, 3 = three-pointer. */
  points: 1 | 2 | 3;
}

export interface ReboundMetadata {
  type: 'offensive' | 'defensive';
}

export interface GameEvent {
  id: string;
  gameId: string;
  /** `null` on the wire for an event without a player. */
  playerId?: string | null;
  eventType: GameEventType;
  timestamp: string;
  metadata: ShotMetadata | Record<string, unknown>;
  createdAt: string;
  /** `null` for an event without a player (a timeout, a team event): `playerId` is optional. */
  player: {
    id: string;
    name: string;
    isManaged: boolean;
    /** Set when the account was deleted; render via `displayName`. */
    deletedAt: string | null;
  } | null;
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
    /** Roster managers and the row's own user only; `null` for a user without an address. */
    email?: string | null;
    isManaged: boolean;
    /** Set when the account was deleted; render via `displayName`. */
    deletedAt: string | null;
  };
}

export interface RsvpSummary {
  yes: number;
  no: number;
  maybe: number;
}
