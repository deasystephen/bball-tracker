/**
 * The age screen (#981, part of #980 adults-only accounts).
 *
 * Hooplings accounts are for ages 13 and up (16 in the EU, UK and
 * Switzerland); a younger player is a roster record a coach or parent keeps.
 * The API answers `user.ageConfirmed: false` for an account that has not yet
 * answered the neutral birth month/year question, and refuses every other
 * route with 403 `age_confirmation_required` until it has. The question is
 * asked once per account (`app/onboarding/age.tsx`); the answer is sent to
 * `POST /auth/age-confirmation` and never stored anywhere, on the device or
 * the server. A field the API does not send (an older API) reads as confirmed:
 * the server is the authority and would refuse if it cared.
 */

import { getLocales } from 'expo-localization';
import type { User } from '../../shared/types';
import { apiErrorCode } from './api-error-code';

export const AGE_CONFIRMATION_ROUTE = '/onboarding/age' as const;

/** The server's code when a request needs the age question answered first. */
export const AGE_CONFIRMATION_REQUIRED_CODE = 'age_confirmation_required';
/** The server's code for an answer under the minimum: the account is gone. */
export const UNDER_MINIMUM_AGE_CODE = 'under_minimum_age';

/** True when the signed-in user must answer the age question before anything else. */
export function needsAgeConfirmation(user: Pick<User, 'ageConfirmed'> | null | undefined): boolean {
  return user?.ageConfirmed === false;
}

export const isAgeConfirmationRequiredError = (error: unknown): boolean =>
  apiErrorCode(error) === AGE_CONFIRMATION_REQUIRED_CODE;

export const isUnderMinimumAgeError = (error: unknown): boolean =>
  apiErrorCode(error) === UNDER_MINIMUM_AGE_CODE;

/**
 * True when the refusal could not be applied automatically and an operator
 * will finish (`pendingOperator` in the body): the account showed adult
 * signals, so the screen points at support instead of saying the service is
 * for 13 and up.
 */
export const isPendingOperatorRefusal = (error: unknown): boolean => {
  if (!isUnderMinimumAgeError(error)) return false;
  const details = (error as { apiError?: { pendingOperator?: unknown } }).apiError;
  return details?.pendingOperator === true;
};

/**
 * The device's region setting (ISO 3166-1 alpha-2), which decides the
 * threshold on the server (13, or 16 in the EU, UK and Switzerland). Sent
 * with the answer only; `undefined` when the device reports none.
 */
export function deviceRegionCode(): string | undefined {
  try {
    const region = getLocales()[0]?.regionCode;
    return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

/** The earliest birth year the form accepts (the API's floor). */
export const MIN_BIRTH_YEAR = 1900;

/** A four-digit year between the floor and this year, or null. */
export function parseBirthYear(text: string, now: Date = new Date()): number | null {
  if (!/^\d{4}$/.test(text.trim())) return null;
  const year = Number(text.trim());
  return year >= MIN_BIRTH_YEAR && year <= now.getUTCFullYear() ? year : null;
}

export interface AgeAnswer {
  /** 1–12 */
  birthMonth: number;
  birthYear: number;
}
