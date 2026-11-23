import { DEFAULT_MINIMUM_AGE, GDPR_MINIMUM_AGE } from './minimum-age';

/**
 * Custom error classes for the application
 */

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404);
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request') {
    super(message, 400);
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403);
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

/**
 * An AppError whose response body carries a machine-readable `code` plus a
 * structured `details` payload the client renders (an upgrade CTA, a list of
 * teams to fix first, …). There is ONE serialization rule for these — `body()`
 * — used by the central error handler in `index.ts` and by any route that
 * answers inline; never hand-roll `{ code, ...details }` at a call site
 * (#444 review 6B; the 402 body used to be copied per route).
 */
export abstract class DetailedError<TDetails extends Record<string, unknown>> extends AppError {
  constructor(
    public readonly code: string,
    public readonly details: TDetails,
    message: string,
    statusCode: number
  ) {
    super(message, statusCode);
    Object.setPrototypeOf(this, DetailedError.prototype);
  }

  /** The full JSON body for this error: `{ error, code, ...details }`. */
  body(): { error: string; code: string } & TDetails {
    return { error: this.message, code: this.code, ...this.details };
  }
}

export interface UpgradeRequiredDetails extends Record<string, unknown> {
  feature: string;
  currentTier: string;
  requiredTier: string;
}

/**
 * 402 Payment Required — the caller's subscription tier does not allow the
 * action. `details` is the `upgrade_required` payload the client renders as an
 * upgrade CTA (same shape as the entitlement middleware's 402 body).
 */
export class PaymentRequiredError extends DetailedError<UpgradeRequiredDetails> {
  constructor(details: UpgradeRequiredDetails, message: string = 'Upgrade required') {
    super('upgrade_required', details, message, 402);
    Object.setPrototypeOf(this, PaymentRequiredError.prototype);
  }
}

export interface LastHeadCoachDetails extends Record<string, unknown> {
  /** Teams (in active seasons) where the user is the only head coach. */
  teams: { id: string; name: string }[];
}

/**
 * 400 — the account cannot be deleted while its owner is the only head coach
 * of a team in an active season (#444, decision D4). The client lists the
 * teams so the user can re-role someone or delete the team first.
 */
export class LastHeadCoachError extends DetailedError<LastHeadCoachDetails> {
  constructor(teams: LastHeadCoachDetails['teams']) {
    super(
      'last_head_coach',
      { teams },
      'You are the only Head Coach of a team in an active season. Make someone else Head Coach or delete the team first.',
      400
    );
    Object.setPrototypeOf(this, LastHeadCoachError.prototype);
  }
}

export interface ResendCooldownDetails extends Record<string, unknown> {
  /** Seconds until the same player can be sent a fresh invitation. */
  retryAfterSeconds: number;
}

/**
 * 429 — an invitation for this player was created moments ago, so a resend
 * (supersede) is refused without expiring the live row or sending email
 * (#715). Bounds how often one recipient can be mailed through Resend.
 */
export class ResendCooldownError extends DetailedError<ResendCooldownDetails> {
  /** `recipient` names who was just mailed: the team invite's player, or a guardian invite's address (#420). */
  constructor(retryAfterSeconds: number, recipient: 'player' | 'address' = 'player') {
    super(
      'resend_cooldown',
      { retryAfterSeconds },
      `An invitation was just sent to this ${recipient}. Try again in ${retryAfterSeconds} seconds.`,
      429
    );
    Object.setPrototypeOf(this, ResendCooldownError.prototype);
  }
}

/**
 * 403 — a sign-in whose WorkOS identity has an unverified email (#907, #956).
 * No account without a verified email: a brand-new row is not created for it,
 * a pre-provisioned row (a coach-added player, a `POST /players` account, an
 * admin pre-create) stays unclaimed, because claiming hands over its team
 * memberships and ends the coach's control, and a linked user whose address
 * flipped to unverified in WorkOS is refused until it is verified again.
 * Nothing is written; the person signs in again once the identity provider has
 * verified the address. Deliberately not a `ConflictError`: the callback treats
 * 409 as the WorkOS key-cutover signature and alarms on it.
 */
export class EmailNotVerifiedError extends DetailedError<Record<string, unknown>> {
  constructor() {
    super(
      'email_not_verified',
      {},
      'Your email address is not verified. Verify it, then sign in again.',
      403
    );
    Object.setPrototypeOf(this, EmailNotVerifiedError.prototype);
  }
}

/**
 * 403 — the account holder has not yet answered the age question (#981). Every
 * authenticated route other than the handful the age screen itself needs
 * (`api/auth/middleware.ts#AGE_GATE_EXEMPT`) answers this until
 * `POST /auth/age-confirmation` has set `User.ageConfirmedAt`. The mobile
 * client routes to the age screen on this code.
 */
export class AgeConfirmationRequiredError extends DetailedError<Record<string, never>> {
  constructor() {
    super('age_confirmation_required', {}, 'Please confirm your age to continue', 403);
    Object.setPrototypeOf(this, AgeConfirmationRequiredError.prototype);
  }
}

/**
 * 403 — the age answer is below the minimum for the account holder's region
 * (#981). By the time this is sent the account is gone (erased, or un-claimed
 * back into a managed roster record) and the WorkOS user with it, or, when
 * neither could be done automatically, the session is revoked and an operator
 * finishes by the runbook. The body carries no detail about the answer.
 */
export interface UnderMinimumAgeDetails extends Record<string, unknown> {
  /**
   * True when the account could not be removed automatically and an operator
   * will finish (an account with adult signals, far more likely a typo than a
   * child): the client points the person at support instead of telling them
   * the service is for 13 and up.
   */
  pendingOperator: boolean;
}

export class UnderMinimumAgeError extends DetailedError<UnderMinimumAgeDetails> {
  constructor(pendingOperator = false) {
    super(
      'under_minimum_age',
      { pendingOperator },
      `Accounts are for ages ${DEFAULT_MINIMUM_AGE} and up (${GDPR_MINIMUM_AGE} in the EU, UK and Switzerland)`,
      403
    );
    Object.setPrototypeOf(this, UnderMinimumAgeError.prototype);
  }
}

/**
 * 409 — a season rollover (#461) found the lineage already has a team-season
 * in that season, and the caller may not manage that row (no
 * `canManageRoster` on it, e.g. a coach removed from it). The body carries no
 * id: naming the row would tell a caller about a team they cannot see. A
 * caller who may manage it gets the row itself (200 `created: false`).
 */
export class TeamSeasonExistsError extends DetailedError<Record<string, never>> {
  constructor() {
    super('team_season_exists', {}, 'This team already has a team-season in that season', 409);
    Object.setPrototypeOf(this, TeamSeasonExistsError.prototype);
  }
}

/**
 * 409 — a season rollover (#461) was asked of a team-season that is not its
 * lineage's latest (`latestTeamSeasonId`). Only the latest row continues a
 * team: otherwise a coach removed from this season could roll last season's
 * row forward and come back as head coach. No ids in the body.
 */
export class NotLatestSeasonError extends DetailedError<Record<string, never>> {
  constructor() {
    super(
      'not_latest_season',
      {},
      "Only the team's most recent season can start the next one",
      409
    );
    Object.setPrototypeOf(this, NotLatestSeasonError.prototype);
  }
}

/**
 * 409 — a season rollover (#461) resolved to a season of the league that is
 * archived (`isActive: false`), by name or by id. A team is never rolled
 * into an archived season; the coach picks or names an active one. No ids.
 */
export class SeasonArchivedError extends DetailedError<Record<string, never>> {
  constructor() {
    super('season_archived', {}, 'That season is archived; pick or name an active season', 409);
    Object.setPrototypeOf(this, SeasonArchivedError.prototype);
  }
}

/**
 * 400 — a season rollover (#461) named or picked a season that starts no later
 * than the team's current one (`isSeasonAfter`, enforced only when both have
 * a start date). Rolling into an older season would make an old team-season
 * the newest row and lock the real current one. No ids.
 */
export class SeasonNotAfterSourceError extends DetailedError<Record<string, never>> {
  constructor() {
    super('season_not_after_source', {}, "The next season must come after the team's current season", 400);
    Object.setPrototypeOf(this, SeasonNotAfterSourceError.prototype);
  }
}

/**
 * 400 `upload_expired` — the avatar upload a profile write names no longer
 * exists: it was never saved within the pending window and the bucket's
 * lifecycle rule expired it (#1005). Nothing was written; the client asks the
 * user to choose the photo again.
 */
export class UploadExpiredError extends DetailedError<Record<string, unknown>> {
  constructor() {
    super('upload_expired', {}, 'That photo upload expired. Please choose it again.', 400);
    Object.setPrototypeOf(this, UploadExpiredError.prototype);
  }
}

/**
 * 409 `sign_in_required` — a staff invitation (#460) cannot be accepted from
 * the public link because the address belongs to an account: a claimed one
 * (a forwarded link must not act on someone's login) or an unclaimed managed
 * roster record (its managing coach may still rewrite that email, B2.10, so a
 * staff role on the row would be a grant the coach could claim). The invitee
 * signs in with the address and accepts in the app instead.
 */
export class SignInRequiredError extends DetailedError<Record<string, never>> {
  constructor() {
    super(
      'sign_in_required',
      {},
      'Sign in to the app with this email address to accept this invitation',
      409
    );
    Object.setPrototypeOf(this, SignInRequiredError.prototype);
  }
}

/**
 * 404 `staff_target_not_found` — `POST /teams/:teamId/staff` found no live
 * account for the `userId` / `email` (#460). The app branches on the code to
 * offer a staff invitation instead; the message is the old plain 404's.
 */
export class StaffTargetNotFoundError extends DetailedError<Record<string, never>> {
  constructor() {
    super('staff_target_not_found', {}, 'User not found', 404);
    Object.setPrototypeOf(this, StaffTargetNotFoundError.prototype);
  }
}

/**
 * 400 `staff_target_needs_invitation` — `POST /teams/:teamId/staff` was given
 * an unclaimed managed roster record (#460). The app offers a staff invitation
 * for the address instead, as for an unknown one.
 */
export class StaffTargetNeedsInvitationError extends DetailedError<Record<string, never>> {
  constructor() {
    super(
      'staff_target_needs_invitation',
      {},
      'This address belongs to a roster record that has not signed in. Send a staff invitation instead.',
      400
    );
    Object.setPrototypeOf(this, StaffTargetNeedsInvitationError.prototype);
  }
}

/**
 * 403 `claimed_account` — `DELETE /players/:id` was aimed at an account that
 * has a login (`workosUserId` set), ADMIN callers included (#1034). Such an
 * account is deleted only by its owner (`DELETE /auth/me`, which runs
 * `AccountService.deleteAccount` and removes the WorkOS identity), or by an
 * operator through `backend/scripts/data-subject-request.ts`.
 */
export class ClaimedAccountError extends DetailedError<Record<string, never>> {
  constructor() {
    super(
      'claimed_account',
      {},
      'This account has its own sign-in, so it cannot be deleted as a roster record. Its owner deletes it from the app (DELETE /auth/me); an operator uses the data-subject-request script.',
      403
    );
    Object.setPrototypeOf(this, ClaimedAccountError.prototype);
  }
}

export interface JoinLinkInactiveDetails extends Record<string, unknown> {
  /** Why the link takes no more requests: past `expiresAt`, or at `maxUses`. */
  reason: 'expired' | 'full';
}

/**
 * 410 `join_link_inactive` — a team join link (#210) that exists and was not
 * revoked, but takes no more requests. The app and the web page branch on
 * `reason` to tell the family to ask the coach for a new link. A revoked or
 * unknown link is a plain 404 instead: a rotated link tells its holder nothing.
 */
export class JoinLinkInactiveError extends DetailedError<JoinLinkInactiveDetails> {
  constructor(reason: JoinLinkInactiveDetails['reason']) {
    super(
      'join_link_inactive',
      { reason },
      reason === 'expired'
        ? 'This join link has expired. Ask the coach for a new one.'
        : 'This join link has reached its limit. Ask the coach for a new one.',
      410
    );
    Object.setPrototypeOf(this, JoinLinkInactiveError.prototype);
  }
}

export interface JoinPlayerUnavailableDetails extends Record<string, unknown> {
  /**
   * Why the roster record cannot take this request (#1072): it is not on the
   * team (any more), it is not a live managed record (it has its own login,
   * or was deleted), or it already has a parent or guardian linked.
   */
  reason: 'not_on_team' | 'not_managed' | 'has_guardian';
}

/**
 * 409 `join_player_unavailable` — a coach approved a CHILD join request onto
 * an existing roster record (#1072) that cannot take it. Judged under the
 * record's row lock, so the loser of two approvals onto the same record gets
 * this with `has_guardian` and nothing is written. The app re-reads the team
 * so the choice is offered again from fresh data.
 */
export class JoinPlayerUnavailableError extends DetailedError<JoinPlayerUnavailableDetails> {
  constructor(reason: JoinPlayerUnavailableDetails['reason']) {
    super(
      'join_player_unavailable',
      { reason },
      reason === 'has_guardian'
        ? 'That player already has a parent or guardian linked. Choose another player or add a new one.'
        : 'That player can no longer be linked to this request. Choose another player or add a new one.',
      409
    );
    Object.setPrototypeOf(this, JoinPlayerUnavailableError.prototype);
  }
}

/**
 * 409 `player_has_records`: `DELETE /players/:id` hard-deletes an unclaimed
 * roster record only when nothing references it (#1047), the rule account
 * deletion uses to erase a row instead of tombstoning it (#529). `relations`
 * names the `User` relations that still hold rows (`guardiansAsChild`,
 * `gameRsvps`, …), so a client or operator can say what is in the way.
 */
export class PlayerHasRecordsError extends DetailedError<{ relations: string[] }> {
  constructor(relations: string[]) {
    super(
      'player_has_records',
      { relations },
      'This player has records that deleting the roster entry would erase (see relations: guardian links, invitations, RSVPs, practice answers or stats), so it is kept. Such a record is removed only through account deletion, which keeps what other people rely on: by a linked guardian for a managed child, otherwise by an operator.',
      409
    );
    Object.setPrototypeOf(this, PlayerHasRecordsError.prototype);
  }
}

export interface JerseyNumberTakenDetails extends Record<string, unknown> {
  /** The number that was asked for. */
  jerseyNumber: number;
  /** The current member of the team who holds it. */
  playerId: string;
  /** That member's name, for the inline error ("#8 is already worn by …"); never in the message. */
  playerName: string;
  /** Set when that member is a deleted account's roster entry: the client shows its own label (#813). */
  playerDeletedAt: Date | null;
}

/**
 * 409 `jersey_number_taken`: another current member of the team already wears
 * this number (#1087). Refused on Add Player, on adding a member, on sending an
 * invitation with an explicit number and on "Edit jersey & position"; the app
 * shows it against the jersey field. Never raised on accepting an invitation:
 * that joins with no number instead (`utils/jersey-number.ts`).
 */
export class JerseyNumberTakenError extends DetailedError<JerseyNumberTakenDetails> {
  constructor(details: JerseyNumberTakenDetails) {
    // The message never names the holder: route catches log it
    // (`logRouteError`), and a name never goes into a log line. The name
    // rides in the body only.
    super(
      'jersey_number_taken',
      details,
      `Another player on this team already wears number ${details.jerseyNumber}.`,
      409
    );
    Object.setPrototypeOf(this, JerseyNumberTakenError.prototype);
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Conflict') {
    super(message, 409);
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/** Why `AccountService.convertToManaged` refused (#983). Stable: the operator CLI maps each to advice. */
export type ConvertRefusalCode =
  | 'already_managed'
  | 'never_signed_in'
  | 'adult_account'
  | 'personal_league_in_use'
  | 'coach_not_on_team'
  | 'no_active_team'
  | 'no_head_coach'
  | 'several_head_coaches'
  | 'coach_unavailable'
  | 'coaches_changed';

/**
 * 409 — an account cannot be converted to a managed roster record (#983).
 * The message describes the state, never a CLI flag; the operator script maps
 * `code` to what to do next.
 */
export class ConvertRefusedError extends DetailedError<Record<string, unknown>> {
  declare readonly code: ConvertRefusalCode;

  constructor(code: ConvertRefusalCode, message: string) {
    super(code, {}, message, 409);
    Object.setPrototypeOf(this, ConvertRefusedError.prototype);
  }
}


/**
 * 503 — a transaction was cancelled while it waited on a row lock (#908):
 * Prisma's interactive-transaction timeout (P2028) or PostgreSQL's
 * `lock_timeout` (55P03). Nothing was written, so the user can safely retry.
 * The central error handler and `respondWithError` render it with
 * `Retry-After`; `models/pool-config.ts#classifyDbError` makes one from the raw
 * database error, which rides on `cause` with its timing.
 */
export class TransactionTimeoutError extends DetailedError<Record<string, unknown>> {
  constructor(cause?: unknown) {
    super(
      'transaction_timeout',
      {},
      'Another request for this record is still being processed; please retry',
      503
    );
    Object.setPrototypeOf(this, TransactionTimeoutError.prototype);
    if (cause !== undefined) this.cause = cause;
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service unavailable') {
    super(message, 503);
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }
}
