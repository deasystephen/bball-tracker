/**
 * Team create/update schema — per-season attributes (#462).
 *
 * ageGroup: trimmed free text, 1..20 chars. gender: closed enum. On update
 * `null` clears either; on create `null` is not a value.
 */

import { createTeamSchema, rolloverTeamSchema, updateTeamSchema } from '../../src/api/teams/schemas';

describe('createTeamSchema — ageGroup / gender', () => {
  it('accepts both fields and trims the age group', () => {
    const result = createTeamSchema.safeParse({ name: 'Warriors', ageGroup: '  U14 ', gender: 'BOYS' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ageGroup).toBe('U14');
      expect(result.data.gender).toBe('BOYS');
    }
  });

  it('accepts a team with neither field (both optional)', () => {
    const result = createTeamSchema.safeParse({ name: 'Warriors' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ageGroup).toBeUndefined();
      expect(result.data.gender).toBeUndefined();
    }
  });

  it.each(['COED', 'GIRLS'])('accepts gender %s', (gender) => {
    expect(createTeamSchema.safeParse({ name: 'W', gender }).success).toBe(true);
  });

  it('rejects an unknown gender value', () => {
    const result = createTeamSchema.safeParse({ name: 'W', gender: 'MIXED' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('gender must be one of BOYS, GIRLS, COED');
    }
  });

  it('rejects an age group longer than 20 characters', () => {
    const result = createTeamSchema.safeParse({ name: 'W', ageGroup: 'x'.repeat(21) });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Age group too long');
    }
  });

  it('rejects a whitespace-only age group (trim happens before min)', () => {
    expect(createTeamSchema.safeParse({ name: 'W', ageGroup: '   ' }).success).toBe(false);
  });

  it('does not accept null on create', () => {
    expect(createTeamSchema.safeParse({ name: 'W', ageGroup: null }).success).toBe(false);
    expect(createTeamSchema.safeParse({ name: 'W', gender: null }).success).toBe(false);
  });
});

describe('updateTeamSchema — ageGroup / gender', () => {
  it('lets null clear either field', () => {
    const result = updateTeamSchema.safeParse({ ageGroup: null, gender: null });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ageGroup).toBeNull();
      expect(result.data.gender).toBeNull();
    }
  });

  it('leaves absent fields undefined (unchanged)', () => {
    const result = updateTeamSchema.safeParse({ name: 'Renamed' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect('ageGroup' in result.data).toBe(false);
      expect('gender' in result.data).toBe(false);
    }
  });

  it('applies the same bounds as create', () => {
    expect(updateTeamSchema.safeParse({ ageGroup: 'x'.repeat(21) }).success).toBe(false);
    expect(updateTeamSchema.safeParse({ gender: 'MEN' }).success).toBe(false);
    expect(updateTeamSchema.safeParse({ ageGroup: ' Grade 7 ', gender: 'COED' })).toMatchObject({
      success: true,
      data: { ageGroup: 'Grade 7', gender: 'COED' },
    });
  });
});

describe('rolloverTeamSchema (#461)', () => {
  const SEASON_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';

  it('accepts a season by id or by trimmed name', () => {
    expect(rolloverTeamSchema.safeParse({ seasonId: SEASON_ID })).toMatchObject({
      success: true,
      data: { seasonId: SEASON_ID },
    });
    expect(rolloverTeamSchema.safeParse({ seasonName: '  2027 ' })).toMatchObject({
      success: true,
      data: { seasonName: '2027' },
    });
  });

  it('requires exactly one of seasonId and seasonName', () => {
    expect(rolloverTeamSchema.safeParse({}).success).toBe(false);
    expect(rolloverTeamSchema.safeParse({ seasonId: SEASON_ID, seasonName: '2027' }).success).toBe(false);
  });

  it('rejects a blank or over-long season name and a malformed seasonId', () => {
    expect(rolloverTeamSchema.safeParse({ seasonName: '   ' }).success).toBe(false);
    expect(rolloverTeamSchema.safeParse({ seasonName: 'x'.repeat(101) }).success).toBe(false);
    expect(rolloverTeamSchema.safeParse({ seasonId: 'not-a-uuid' }).success).toBe(false);
  });

  it('takes optional name and bracket overrides; null clears the bracket, absent carries it', () => {
    const result = rolloverTeamSchema.safeParse({
      seasonName: '2027',
      name: ' Hawks ',
      ageGroup: 'U13',
      gender: null,
    });
    expect(result).toMatchObject({ success: true, data: { name: 'Hawks', ageGroup: 'U13', gender: null } });

    const bare = rolloverTeamSchema.safeParse({ seasonName: '2027' });
    expect(bare.success).toBe(true);
    if (bare.success) {
      expect('name' in bare.data).toBe(false);
      expect('ageGroup' in bare.data).toBe(false);
      expect('gender' in bare.data).toBe(false);
    }
  });

  it('applies the team bounds to the overrides', () => {
    expect(rolloverTeamSchema.safeParse({ seasonName: '2027', name: '' }).success).toBe(false);
    expect(rolloverTeamSchema.safeParse({ seasonName: '2027', ageGroup: 'x'.repeat(21) }).success).toBe(false);
    expect(rolloverTeamSchema.safeParse({ seasonName: '2027', gender: 'MEN' }).success).toBe(false);
  });
});
