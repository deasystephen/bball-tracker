/**
 * The age screen's helpers (#981): who must answer, how the API's codes are
 * recognised, the device region that decides the threshold, and the year the
 * form accepts.
 */
import {
  AGE_CONFIRMATION_ROUTE,
  deviceRegionCode,
  isAgeConfirmationRequiredError,
  isUnderMinimumAgeError,
  needsAgeConfirmation,
  parseBirthYear,
} from '../../utils/age-gate';

describe('needsAgeConfirmation', () => {
  it('is true only for an explicit false: an older API that omits the flag reads as confirmed', () => {
    expect(needsAgeConfirmation({ ageConfirmed: false })).toBe(true);
    expect(needsAgeConfirmation({ ageConfirmed: true })).toBe(false);
    expect(needsAgeConfirmation({})).toBe(false);
    expect(needsAgeConfirmation(null)).toBe(false);
    expect(needsAgeConfirmation(undefined)).toBe(false);
  });

  it('routes to the onboarding age screen', () => {
    expect(AGE_CONFIRMATION_ROUTE).toBe('/onboarding/age');
  });
});

describe('the API codes', () => {
  it('recognise the gate and the refusal from a normalised api error, or the lifted code', () => {
    expect(isAgeConfirmationRequiredError({ apiError: { code: 'age_confirmation_required' } })).toBe(true);
    expect(isAgeConfirmationRequiredError({ code: 'age_confirmation_required' })).toBe(true);
    expect(isUnderMinimumAgeError({ apiError: { code: 'under_minimum_age', status: 403 } })).toBe(true);
    expect(isUnderMinimumAgeError({ apiError: { code: 'age_confirmation_required' } })).toBe(false);
    expect(isAgeConfirmationRequiredError(new Error('nope'))).toBe(false);
    expect(isUnderMinimumAgeError(undefined)).toBe(false);
  });
});

describe('deviceRegionCode', () => {
  it('upper-cases the device region from expo-localization (US in the Jest setup)', () => {
    expect(deviceRegionCode()).toBe('US');
  });
});

describe('parseBirthYear', () => {
  const now = new Date('2026-11-07T12:00:00Z');

  it('accepts a four-digit year between 1900 and this year', () => {
    expect(parseBirthYear('1990', now)).toBe(1990);
    expect(parseBirthYear(' 2026 ', now)).toBe(2026);
    expect(parseBirthYear('1900', now)).toBe(1900);
  });

  it('refuses anything else', () => {
    expect(parseBirthYear('199', now)).toBeNull();
    expect(parseBirthYear('19900', now)).toBeNull();
    expect(parseBirthYear('1899', now)).toBeNull();
    expect(parseBirthYear('2027', now)).toBeNull();
    expect(parseBirthYear('abcd', now)).toBeNull();
    expect(parseBirthYear('', now)).toBeNull();
  });
});
