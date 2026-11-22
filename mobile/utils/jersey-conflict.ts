/**
 * The 409 `jersey_number_taken` refusal (#1087): another current member of
 * the team already wears the number. The API refuses it on Add Player, on
 * sending an invitation with a number and on "Edit jersey & position"; the
 * roster screen shows it against the jersey field, not as a toast.
 *
 * Kept free of imports other than `api-error-code`, like that helper, so it
 * works in tests that mock the api-client.
 */
import { apiErrorCode } from './api-error-code';

export const JERSEY_NUMBER_TAKEN_CODE = 'jersey_number_taken';

export interface JerseyConflict {
  jerseyNumber: number;
  /** The member who wears it. */
  playerId: string;
  /** Their stored name: render through `displayName` with `playerDeletedAt` (tombstones, #813). */
  playerName: string;
  /** ISO timestamp when that account was deleted; null for a live one. */
  playerDeletedAt: string | null;
}

/** The conflict a failed roster request carries, or null for any other error. */
export function getJerseyConflict(error: unknown): JerseyConflict | null {
  if (apiErrorCode(error) !== JERSEY_NUMBER_TAKEN_CODE) return null;
  const body = (error as { apiError?: Record<string, unknown> }).apiError;
  if (!body || typeof body.jerseyNumber !== 'number' || typeof body.playerId !== 'string') return null;
  return {
    jerseyNumber: body.jerseyNumber,
    playerId: body.playerId,
    playerName: typeof body.playerName === 'string' ? body.playerName : '',
    playerDeletedAt: typeof body.playerDeletedAt === 'string' ? body.playerDeletedAt : null,
  };
}
