/**
 * Guardian (PARENT role) helpers — docs/plans/parent-role-spec.md.
 *
 * A user is a guardian whenever `user.guardianOf` (from `GET /auth/me` /
 * `/auth/callback`) is non-empty, regardless of their global role: a coach who
 * is also a parent keeps `COACH`. These helpers only decide what UI to show;
 * the API remains the authority (403).
 */

import type { GuardianOfEntry, GuardianRelationship } from '../../shared/types';
import { i18n } from '../i18n';

export interface GuardianUser {
  id?: string;
  name?: string | null;
  email?: string | null;
  guardianOf?: GuardianOfEntry[] | null;
}

/** Any `{ members?: [{ playerId }] }` shape — `Team` or `game.team`. */
export interface TeamWithMembers {
  members?: { playerId: string }[] | null;
}

export const GUARDIAN_RELATIONSHIPS: readonly GuardianRelationship[] = [
  'MOTHER',
  'FATHER',
  'GUARDIAN',
  'OTHER',
] as const;

function knownRelationship(relationship: GuardianRelationship | string): GuardianRelationship {
  return (GUARDIAN_RELATIONSHIPS as readonly string[]).includes(relationship)
    ? (relationship as GuardianRelationship)
    : 'GUARDIAN';
}

/** Localized relationship name for a label or chip (`guardians.relationship.*`); unknown reads as "Guardian". */
export function relationshipLabel(relationship: GuardianRelationship | string): string {
  return i18n.t(`guardians.relationship.${knownRelationship(relationship)}`);
}

/**
 * The relationship as a noun inside a sentence ("Become Steph's father"), from its own
 * keys (`guardians.relationshipInSentence.*`) so each language sets its own case
 * instead of lower-casing a label.
 */
export function relationshipNoun(relationship: GuardianRelationship | string): string {
  return i18n.t(`guardians.relationshipInSentence.${knownRelationship(relationship)}`);
}

export function guardianChildren(user: GuardianUser | null | undefined): GuardianOfEntry[] {
  return user?.guardianOf ?? [];
}

export function isGuardian(user: GuardianUser | null | undefined): boolean {
  return guardianChildren(user).length > 0;
}

/** The user's children who are currently rostered on `team`. */
export function guardianChildrenOnTeam(
  user: GuardianUser | null | undefined,
  team: TeamWithMembers | null | undefined
): GuardianOfEntry[] {
  const members = team?.members;
  if (!members || members.length === 0) return [];
  const rostered = new Set(members.map((m) => m.playerId));
  return guardianChildren(user).filter((child) => rostered.has(child.childId));
}

/** True when the user themself is rostered on `team`. */
export function isRosteredOn(
  user: { id?: string } | null | undefined,
  team: TeamWithMembers | null | undefined
): boolean {
  if (!user?.id) return false;
  return (team?.members ?? []).some((m) => m.playerId === user.id);
}
