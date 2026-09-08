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

export class ConflictError extends AppError {
  constructor(message: string = 'Conflict') {
    super(message, 409);
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}


export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service unavailable') {
    super(message, 503);
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }
}
