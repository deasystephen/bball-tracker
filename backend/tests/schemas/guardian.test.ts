/**
 * Schema validation tests for guardian (PARENT role) inputs.
 */

import { inviteGuardianSchema } from '../../src/api/invitations/schemas';
import { upsertRsvpSchema } from '../../src/api/games/schemas';

const UUID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';

describe('inviteGuardianSchema', () => {
  it('accepts a valid email + relationship and trims the email', () => {
    const result = inviteGuardianSchema.safeParse({ email: '  parent@example.com ', relationship: 'MOTHER' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('parent@example.com');
      expect(result.data.relationship).toBe('MOTHER');
    }
  });

  it.each(['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER'])('accepts relationship %s', (relationship) => {
    expect(inviteGuardianSchema.safeParse({ email: 'p@example.com', relationship }).success).toBe(true);
  });

  it('rejects an unknown relationship with a helpful message', () => {
    const result = inviteGuardianSchema.safeParse({ email: 'p@example.com', relationship: 'UNCLE' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Relationship must be');
    }
  });

  it('rejects a missing relationship', () => {
    expect(inviteGuardianSchema.safeParse({ email: 'p@example.com' }).success).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(inviteGuardianSchema.safeParse({ email: 'nope', relationship: 'MOTHER' }).success).toBe(false);
  });

  it('rejects an empty email', () => {
    expect(inviteGuardianSchema.safeParse({ email: '', relationship: 'MOTHER' }).success).toBe(false);
  });

  it('rejects an over-long email', () => {
    const email = `${'a'.repeat(250)}@example.com`;
    expect(inviteGuardianSchema.safeParse({ email, relationship: 'MOTHER' }).success).toBe(false);
  });
});

describe('upsertRsvpSchema playerId (RSVP for a child)', () => {
  it('accepts status without playerId', () => {
    const result = upsertRsvpSchema.safeParse({ status: 'YES' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.playerId).toBeUndefined();
    }
  });

  it('accepts a UUID playerId', () => {
    const result = upsertRsvpSchema.safeParse({ status: 'NO', playerId: UUID });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.playerId).toBe(UUID);
    }
  });

  it('rejects a non-UUID playerId', () => {
    const result = upsertRsvpSchema.safeParse({ status: 'NO', playerId: 'kid-1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Invalid player ID format');
    }
  });

  it('rejects an empty-string playerId', () => {
    expect(upsertRsvpSchema.safeParse({ status: 'NO', playerId: '' }).success).toBe(false);
  });

  it('still rejects an invalid status', () => {
    expect(upsertRsvpSchema.safeParse({ status: 'SURE', playerId: UUID }).success).toBe(false);
  });
});
