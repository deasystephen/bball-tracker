/**
 * The mobile client's view of the signed-in `User` payload (the session user
 * from `GET /auth/me`, `GET /auth/callback`, `POST /auth/dev-login` and
 * `PATCH /auth/me`; `SESSION_USER_SELECT` plus `leagueAdminOf` and
 * `guardianOf` in `backend/src/api/auth/routes.ts`) and the enums it uses.
 *
 * Only `mobile/` imports this file; it sits at the repo root so a future
 * consumer can share it, but the backend and web do not import it today.
 * Every export must have an importer under `mobile/`
 * (`mobile/__tests__/types/shared-types-usage.test.ts` fails otherwise), and
 * `mobile/__tests__/types/api-contract.test.ts` pins `User` to the recorded
 * auth payload.
 */

export enum UserRole {
  COACH = 'COACH',
  PARENT = 'PARENT',
  PLAYER = 'PLAYER',
  ADMIN = 'ADMIN',
}

export interface User {
  id: string;
  /** `User.email` is nullable: managed (roster-only) players and tombstones have none. */
  email: string | null;
  name: string;
  role: UserRole;
  profilePictureUrl?: string | null;
  /**
   * IDs of leagues this user administers (LeagueAdmin rows). Optional: older
   * API builds omit it, and clients must treat `undefined` as `[]`.
   */
  leagueAdminOf?: string[];
  /**
   * Children this user is a guardian of (Guardian rows — PARENT role,
   * docs/plans/parent-role-spec.md). Optional like `leagueAdminOf`: older API
   * builds omit it and clients treat `undefined` as `[]`.
   */
  guardianOf?: GuardianOfEntry[];
  /**
   * Push + email when someone replies to one of the user's announcements
   * (#34). Optional like the fields above: older API builds omit it and
   * clients treat `undefined` as `true` (the server default).
   */
  notifyOnReplies?: boolean;
  /**
   * ISO timestamp (JSON carries strings, never `Date`). Every session payload
   * sends it today; optional because a locally patched user may predate it.
   * There is no `updatedAt` on any auth payload.
   */
  createdAt?: string;
}

export type GuardianRelationship = 'MOTHER' | 'FATHER' | 'GUARDIAN' | 'OTHER';

export interface GuardianOfEntry {
  childId: string;
  childName: string;
  /**
   * Set when the child's account was deleted (#813); render via
   * `childDisplayName`. Optional: older API builds omit it.
   */
  childDeletedAt?: string | null;
  relationship: GuardianRelationship;
  isPrimary: boolean;
  /**
   * True when the child is a managed, unclaimed record (`isManaged` and no
   * login yet) — the only kind of child record a guardian may delete via
   * `DELETE /players/:id/account` (#444). Optional: older API builds omit it.
   */
  isManaged?: boolean;
  /** Teams the child is currently rostered on (for deep-linking guardian management). */
  teams?: { id: string; name: string }[];
}
