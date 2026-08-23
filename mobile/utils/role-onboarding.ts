/**
 * Post-login "who are you here as?" step.
 *
 * Every WorkOS sign-up is created as PLAYER on the backend. Coaches need the
 * COACH role to create teams, so the first time a PLAYER signs in on a device
 * we ask once, then remember the answer per user id. COACH/ADMIN/PARENT users
 * never see the step; a PLAYER who picks "player" is not asked again but can
 * change their mind from Profile.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserRole } from '../../shared/types';
import { consumePendingReturnPath } from './return-path';
import { needsDisplayName } from './guardian';

const KEY_PREFIX = 'roleChosen:';

export const ROLE_ONBOARDING_ROUTE = '/onboarding/role' as const;
export const NAME_ONBOARDING_ROUTE = '/onboarding/name' as const;
const NAME_KEY_PREFIX = 'nameAsked:';
export const HOME_ROUTE = '/(tabs)/home' as const;

export function roleChosenKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/**
 * True when the user should be shown the role step before landing on Home.
 * Storage failures fall back to "don't ask" so a flaky AsyncStorage can't
 * trap someone on the onboarding screen.
 */
export async function needsRoleChoice(
  user: { id: string; role: UserRole | string } | null | undefined
): Promise<boolean> {
  if (!user || user.role !== UserRole.PLAYER) return false;
  try {
    return (await AsyncStorage.getItem(roleChosenKey(user.id))) !== 'true';
  } catch {
    return false;
  }
}

export async function markRoleChosen(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(roleChosenKey(userId), 'true');
  } catch {
    // Best effort: worst case the user is asked again next login.
  }
}

export function nameAskedKey(userId: string): string {
  return `${NAME_KEY_PREFIX}${userId}`;
}

/**
 * Guardians whose account was created by a coach's invite carry a placeholder
 * name (the email local part) until they pick one. Ask once per user.
 */
export async function needsNamePrompt(
  user: { id: string; name?: string | null; email?: string | null; guardianOf?: unknown[] | null } | null | undefined
): Promise<boolean> {
  if (!user || !needsDisplayName(user as Parameters<typeof needsDisplayName>[0])) return false;
  try {
    return (await AsyncStorage.getItem(nameAskedKey(user.id))) !== 'true';
  } catch {
    return false;
  }
}

export async function markNameAsked(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(nameAskedKey(userId), 'true');
  } catch {
    // Best effort.
  }
}

/**
 * Where to send a freshly authenticated user.
 *
 * The role step always wins, then the one-time display-name prompt for
 * guardian-created accounts. Otherwise a pending return path (a deep link such
 * as `/invite/<token>` that sent the user to login — see `utils/return-path`)
 * takes precedence over Home.
 */
export async function postLoginRoute(
  user:
    | { id: string; role: UserRole | string; name?: string | null; email?: string | null; guardianOf?: unknown[] | null }
    | null
    | undefined
): Promise<typeof ROLE_ONBOARDING_ROUTE | typeof NAME_ONBOARDING_ROUTE | typeof HOME_ROUTE | string> {
  if (await needsRoleChoice(user)) return ROLE_ONBOARDING_ROUTE;
  if (await needsNamePrompt(user)) return NAME_ONBOARDING_ROUTE;
  return (await consumePendingReturnPath()) ?? HOME_ROUTE;
}
