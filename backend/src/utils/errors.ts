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

export class ConflictError extends AppError {
  constructor(message: string = 'Conflict') {
    super(message, 409);
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}


/**
 * 503 — an interactive transaction expired (Prisma P2028) while it waited on a
 * row lock held by a concurrent twin request (#908). Nothing was written, so
 * the user can safely retry. The central error handler and `respondWithError`
 * create it from the Prisma error (`models/pool-config.ts#isTransactionTimeoutError`)
 * and set `Retry-After` when they render it; an expected contention outcome,
 * logged at warn and not sent to Sentry.
 */
export class TransactionTimeoutError extends DetailedError<Record<string, unknown>> {
  constructor() {
    super(
      'transaction_timeout',
      {},
      'Another request for this record is still being processed; please retry',
      503
    );
    Object.setPrototypeOf(this, TransactionTimeoutError.prototype);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service unavailable') {
    super(message, 503);
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }
}
