/**
 * Schema validation for team join links (#210):
 * `POST /teams/:teamId/join-link`, `POST /join/:token` and
 * `POST /teams/:teamId/join-requests/:requestId/approve` (#1072).
 */

import {
  approveJoinRequestSchema,
  createJoinLinkSchema,
  joinRequestSchema,
  JOIN_LINK_MAX_EXPIRES_DAYS,
  JOIN_LINK_MAX_USES,
} from '../../src/api/join/schemas';

describe('createJoinLinkSchema', () => {
  it('accepts an empty body: the service applies the default lifetime and no cap', () => {
    const result = createJoinLinkSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it('accepts a lifetime and a cap inside their bounds', () => {
    const result = createJoinLinkSchema.safeParse({ expiresInDays: 7, maxUses: 25 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ expiresInDays: 7, maxUses: 25 });
    }
  });

  it('accepts maxUses: null as "no cap"', () => {
    const result = createJoinLinkSchema.safeParse({ maxUses: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxUses).toBeNull();
    }
  });

  it.each([0, -1, 1.5, JOIN_LINK_MAX_EXPIRES_DAYS + 1, '7', null])('rejects expiresInDays %p', (expiresInDays) => {
    expect(createJoinLinkSchema.safeParse({ expiresInDays }).success).toBe(false);
  });

  it.each([0, -3, 2.5, JOIN_LINK_MAX_USES + 1, '10'])('rejects maxUses %p', (maxUses) => {
    expect(createJoinLinkSchema.safeParse({ maxUses }).success).toBe(false);
  });

  it('accepts the bounds themselves', () => {
    expect(createJoinLinkSchema.safeParse({ expiresInDays: 1, maxUses: 1 }).success).toBe(true);
    expect(
      createJoinLinkSchema.safeParse({ expiresInDays: JOIN_LINK_MAX_EXPIRES_DAYS, maxUses: JOIN_LINK_MAX_USES }).success
    ).toBe(true);
  });

  it('strips unknown keys such as a token or an expiry date', () => {
    const result = createJoinLinkSchema.safeParse({ token: 'mine', expiresAt: '2099-01-01', revokedAt: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });
});

describe('joinRequestSchema', () => {
  it('accepts a self request and strips everything else', () => {
    const result = joinRequestSchema.safeParse({ kind: 'self', childName: 'Ignored', teamId: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: 'self' });
    }
  });

  it('accepts a child request and trims the name', () => {
    const result = joinRequestSchema.safeParse({ kind: 'child', childName: '  Riley Park ', relationship: 'MOTHER' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: 'child', childName: 'Riley Park', relationship: 'MOTHER' });
    }
  });

  it.each(['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER'])('accepts relationship %s', (relationship) => {
    expect(joinRequestSchema.safeParse({ kind: 'child', childName: 'Riley', relationship }).success).toBe(true);
  });

  it.each(['mother', 'AUNT', '', undefined])('rejects relationship %p with the shared message', (relationship) => {
    const result = joinRequestSchema.safeParse({ kind: 'child', childName: 'Riley', relationship });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Relationship must be MOTHER, FATHER, GUARDIAN or OTHER');
    }
  });

  it.each(['', '   ', undefined, 42])('rejects the child name %p', (childName) => {
    expect(joinRequestSchema.safeParse({ kind: 'child', childName, relationship: 'FATHER' }).success).toBe(false);
  });

  it('rejects a child name longer than 100 characters', () => {
    expect(
      joinRequestSchema.safeParse({ kind: 'child', childName: 'a'.repeat(101), relationship: 'FATHER' }).success
    ).toBe(false);
  });

  it.each([undefined, 'SELF', 'player', 'coach', 1])('rejects kind %p', (kind) => {
    const result = joinRequestSchema.safeParse({ kind });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('kind must be self or child');
    }
  });

  it('never accepts an email, an age or a date of birth for a child (unknown keys are stripped)', () => {
    const result = joinRequestSchema.safeParse({
      kind: 'child',
      childName: 'Riley',
      relationship: 'GUARDIAN',
      childEmail: 'riley@example.com',
      age: 9,
      dateOfBirth: '2017-03-01',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: 'child', childName: 'Riley', relationship: 'GUARDIAN' });
    }
  });
});

describe('approveJoinRequestSchema (#1072)', () => {
  const PLAYER_ID = 'c8d9e0f1-a2b3-4567-a901-cdef01234567';

  it('accepts an empty body: approve as before (SELF joins, CHILD creates a new record)', () => {
    const result = approveJoinRequestSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it('accepts the existing roster record to link a CHILD request to', () => {
    const result = approveJoinRequestSchema.safeParse({ playerId: PLAYER_ID });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ playerId: PLAYER_ID });
    }
  });

  it('strips unknown keys', () => {
    const result = approveJoinRequestSchema.safeParse({ playerId: PLAYER_ID, childName: 'Riley', isPrimary: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ playerId: PLAYER_ID });
    }
  });

  it.each(['not-a-uuid', '', 42, null])('rejects playerId %p', (playerId) => {
    expect(approveJoinRequestSchema.safeParse({ playerId }).success).toBe(false);
  });

  it('names the field in the message', () => {
    const result = approveJoinRequestSchema.safeParse({ playerId: 'nope' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('playerId must be a valid UUID');
    }
  });
});
