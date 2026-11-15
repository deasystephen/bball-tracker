/**
 * Schema tests for practice scheduling (#33): POST /practices,
 * PATCH /practices/:id, POST /practices/:id/cancel, POST /practice-series,
 * PATCH /practice-series/:id, GET /practices and PUT /practices/:id/availability.
 */

import {
  cancelPracticeSchema,
  createPracticeSchema,
  createPracticeSeriesSchema,
  MAX_SERIES_OCCURRENCES,
  practiceQuerySchema,
  updatePracticeSchema,
  updatePracticeSeriesSchema,
  upsertAvailabilitySchema,
} from '../../src/api/practices/schemas';

const TEAM_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const validPractice = {
  teamId: TEAM_ID,
  startsAt: '2026-11-17T23:00:00Z',
  durationMinutes: 90,
  timezone: 'America/New_York',
};

const validSeries = {
  teamId: TEAM_ID,
  frequency: 'WEEKLY',
  weekdays: [2, 4],
  startDate: '2026-11-17',
  startTime: '18:00',
  durationMinutes: 90,
  timezone: 'America/New_York',
  endDate: '2027-02-28',
};

describe('createPracticeSchema', () => {
  it('accepts the minimal body and defaults type to PRACTICE', () => {
    const result = createPracticeSchema.safeParse(validPractice);
    expect(result.success).toBe(true);
    expect(result.data?.type).toBe('PRACTICE');
  });

  it('accepts an offset instead of Z, OTHER, and trims text', () => {
    const result = createPracticeSchema.safeParse({
      ...validPractice,
      startsAt: '2026-11-17T18:00:00-05:00',
      type: 'OTHER',
      title: '  Team dinner  ',
      location: '',
    });
    expect(result.success).toBe(true);
    expect(result.data?.title).toBe('Team dinner');
    expect(result.data?.location).toBeNull();
  });

  it('stores the canonical zone name', () => {
    expect(createPracticeSchema.safeParse({ ...validPractice, timezone: 'america/new_york' }).data?.timezone).toBe(
      'America/New_York'
    );
    expect(createPracticeSchema.safeParse({ ...validPractice, timezone: 'US/Eastern' }).data?.timezone).toBe(
      'America/New_York'
    );
    expect(createPracticeSchema.safeParse({ ...validPractice, timezone: 'utc' }).data?.timezone).toBe('UTC');
  });

  it.each([
    ['a fixed offset zone, which ignores DST', { timezone: '+05:30' }],
    ['a missing teamId', { teamId: undefined }],
    ['a non-uuid teamId', { teamId: 'team-1' }],
    ['a floating local startsAt', { startsAt: '2026-11-17T18:00:00' }],
    ['a date-only startsAt', { startsAt: '2026-11-17' }],
    ['durationMinutes 4', { durationMinutes: 4 }],
    ['durationMinutes 721', { durationMinutes: 721 }],
    ['a fractional duration', { durationMinutes: 60.5 }],
    ['an unknown zone', { timezone: 'Mars/Base' }],
    ['a missing zone', { timezone: undefined }],
    ['type GAME (games stay in /games)', { type: 'GAME' }],
    ['a 101-character title', { title: 'x'.repeat(101) }],
    ['a 201-character location', { location: 'x'.repeat(201) }],
    ['1001 characters of notes', { notes: 'x'.repeat(1001) }],
  ])('rejects %s', (_label, patch) => {
    expect(createPracticeSchema.safeParse({ ...validPractice, ...patch }).success).toBe(false);
  });
});

describe('updatePracticeSchema', () => {
  it('accepts a single field, and null to clear text', () => {
    expect(updatePracticeSchema.safeParse({ location: 'Gym B' }).success).toBe(true);
    expect(updatePracticeSchema.safeParse({ notes: null }).data).toEqual({ notes: null });
  });

  it('rejects an empty body, an unknown key and a bad value', () => {
    expect(updatePracticeSchema.safeParse({}).success).toBe(false);
    expect(updatePracticeSchema.safeParse({ status: 'CANCELLED' }).success).toBe(false);
    expect(updatePracticeSchema.safeParse({ startsAt: 'tomorrow' }).success).toBe(false);
  });
});

describe('cancelPracticeSchema', () => {
  it('accepts no reason or a reason, and refuses a long one', () => {
    expect(cancelPracticeSchema.safeParse({}).success).toBe(true);
    expect(cancelPracticeSchema.safeParse({ reason: 'Gym closed' }).data).toEqual({ reason: 'Gym closed' });
    expect(cancelPracticeSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('createPracticeSeriesSchema', () => {
  it('accepts an endDate rule and a count rule', () => {
    expect(createPracticeSeriesSchema.safeParse(validSeries).success).toBe(true);
    expect(
      createPracticeSeriesSchema.safeParse({ ...validSeries, endDate: undefined, occurrenceCount: 10 }).success
    ).toBe(true);
  });

  it('accepts endDate equal to startDate and exactly a year later', () => {
    expect(createPracticeSeriesSchema.safeParse({ ...validSeries, endDate: '2026-11-17' }).success).toBe(true);
    expect(createPracticeSeriesSchema.safeParse({ ...validSeries, endDate: '2027-11-18' }).success).toBe(true);
  });

  it.each([
    ['both end conditions', { occurrenceCount: 5 }],
    ['neither end condition', { endDate: undefined }],
    ['endDate before startDate', { endDate: '2026-11-16' }],
    ['endDate more than 366 days out', { endDate: '2027-11-19' }],
    ['a non-existent date', { startDate: '2027-02-30' }],
    ['a badly formatted date', { startDate: '17/11/2026' }],
    ['startTime 24:00', { startTime: '24:00' }],
    ['startTime 6pm', { startTime: '6pm' }],
    ['startTime without a leading zero', { startTime: '6:00' }],
    ['no weekdays', { weekdays: [] }],
    ['weekday 7', { weekdays: [7] }],
    ['a repeated weekday', { weekdays: [2, 2] }],
    ['frequency DAILY', { frequency: 'DAILY' }],
    ['an unknown zone', { timezone: 'Nowhere/Town' }],
  ])('rejects %s', (_label, patch) => {
    expect(createPracticeSeriesSchema.safeParse({ ...validSeries, ...patch }).success).toBe(false);
  });

  it(`bounds occurrenceCount to 1..${MAX_SERIES_OCCURRENCES}`, () => {
    const withCount = (occurrenceCount: number): boolean =>
      createPracticeSeriesSchema.safeParse({ ...validSeries, endDate: undefined, occurrenceCount }).success;
    expect(withCount(1)).toBe(true);
    expect(withCount(MAX_SERIES_OCCURRENCES)).toBe(true);
    expect(withCount(0)).toBe(false);
    expect(withCount(MAX_SERIES_OCCURRENCES + 1)).toBe(false);
  });
});

describe('updatePracticeSeriesSchema', () => {
  it('accepts descriptive fields only', () => {
    expect(updatePracticeSeriesSchema.safeParse({ location: 'Gym B' }).success).toBe(true);
    expect(updatePracticeSeriesSchema.safeParse({}).success).toBe(false);
    expect(updatePracticeSeriesSchema.safeParse({ startTime: '19:00' }).success).toBe(false);
    expect(updatePracticeSeriesSchema.safeParse({ weekdays: [1] }).success).toBe(false);
  });
});

describe('practiceQuerySchema', () => {
  it('defaults to limit 50, offset 0', () => {
    expect(practiceQuerySchema.safeParse({}).data).toEqual({ limit: 50, offset: 0 });
  });

  it('coerces query-string values and accepts a window', () => {
    expect(
      practiceQuerySchema.safeParse({
        teamId: TEAM_ID,
        status: 'SCHEDULED',
        from: '2026-11-01T00:00:00Z',
        to: '2026-12-01T00:00:00Z',
        limit: '200',
        offset: '10',
      }).data
    ).toEqual({
      teamId: TEAM_ID,
      status: 'SCHEDULED',
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
      limit: 200,
      offset: 10,
    });
  });

  it.each([
    ['limit 0', { limit: '0' }],
    ['limit 201', { limit: '201' }],
    ['offset -1', { offset: '-1' }],
    ['a bad status', { status: 'DONE' }],
    ['a bad teamId', { teamId: 'x' }],
    ['a date-only from', { from: '2026-11-01' }],
    ['from after to', { from: '2026-12-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }],
  ])('rejects %s', (_label, query) => {
    expect(practiceQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('upsertAvailabilitySchema', () => {
  it('accepts a status, a comment and a child', () => {
    expect(upsertAvailabilitySchema.safeParse({ status: 'YES' }).success).toBe(true);
    expect(
      upsertAvailabilitySchema.safeParse({ status: 'NO', comment: 'Away', playerId: TEAM_ID }).data
    ).toEqual({ status: 'NO', comment: 'Away', playerId: TEAM_ID });
  });

  it('rejects a bad status, a long comment and a bad playerId', () => {
    expect(upsertAvailabilitySchema.safeParse({ status: 'LATE' }).success).toBe(false);
    expect(upsertAvailabilitySchema.safeParse({ status: 'YES', comment: 'x'.repeat(501) }).success).toBe(false);
    expect(upsertAvailabilitySchema.safeParse({ status: 'YES', playerId: 'kid' }).success).toBe(false);
  });
});
