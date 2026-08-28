/**
 * Validation tests for the unified Add Player schema
 * (roster/invite unification spec).
 */

import { addRosterPlayerSchema } from '../../src/api/teams/schemas';
import { createInvitationSchema } from '../../src/api/invitations/schemas';

describe('addRosterPlayerSchema', () => {
  it('accepts a name-only player (case 1)', () => {
    const result = addRosterPlayerSchema.safeParse({ name: 'Kid Hooper' });
    expect(result.success).toBe(true);
  });

  it('accepts name + player email (case 2/3)', () => {
    const result = addRosterPlayerSchema.safeParse({
      name: 'Jane Hooper',
      playerEmail: 'jane@example.com',
    });
    expect(result.success).toBe(true);
  });

  it('accepts jersey number 0 (0 is a valid number, never truthiness)', () => {
    const result = addRosterPlayerSchema.safeParse({ name: 'Kid', jerseyNumber: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jerseyNumber).toBe(0);
    }
  });

  it('rejects a missing or empty name', () => {
    expect(addRosterPlayerSchema.safeParse({}).success).toBe(false);
    expect(addRosterPlayerSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects an invalid player email', () => {
    const result = addRosterPlayerSchema.safeParse({ name: 'Jane', playerEmail: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('accepts guardian email + relationship together', () => {
    const result = addRosterPlayerSchema.safeParse({
      name: 'Kid',
      guardianEmail: 'mom@example.com',
      guardianRelationship: 'MOTHER',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a guardian email without a relationship (and vice versa)', () => {
    expect(
      addRosterPlayerSchema.safeParse({ name: 'Kid', guardianEmail: 'mom@example.com' }).success
    ).toBe(false);
    expect(
      addRosterPlayerSchema.safeParse({ name: 'Kid', guardianRelationship: 'MOTHER' }).success
    ).toBe(false);
  });

  it('rejects an unknown relationship value', () => {
    const result = addRosterPlayerSchema.safeParse({
      name: 'Kid',
      guardianEmail: 'mom@example.com',
      guardianRelationship: 'AUNT',
    });
    expect(result.success).toBe(false);
  });

  it('rejects identical player and guardian emails, case-insensitively', () => {
    const result = addRosterPlayerSchema.safeParse({
      name: 'Jane',
      playerEmail: 'same@example.com',
      guardianEmail: 'Same@Example.com',
      guardianRelationship: 'MOTHER',
    });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range jersey numbers', () => {
    expect(addRosterPlayerSchema.safeParse({ name: 'Kid', jerseyNumber: -1 }).success).toBe(false);
    expect(addRosterPlayerSchema.safeParse({ name: 'Kid', jerseyNumber: 100 }).success).toBe(false);
  });

  it('trims the emails and name', () => {
    const result = addRosterPlayerSchema.safeParse({
      name: '  Jane Hooper  ',
      playerEmail: '  jane@example.com  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Jane Hooper');
      expect(result.data.playerEmail).toBe('jane@example.com');
    }
  });
});

describe('createInvitationSchema supersede (resend path)', () => {
  it('defaults supersede to false', () => {
    const result = createInvitationSchema.safeParse({
      playerId: '2c9a4f1e-8b1d-4f6a-9c3e-1a2b3c4d5e6f',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supersede).toBe(false);
    }
  });

  it('accepts supersede: true with a playerId', () => {
    const result = createInvitationSchema.safeParse({
      playerId: '2c9a4f1e-8b1d-4f6a-9c3e-1a2b3c4d5e6f',
      supersede: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supersede).toBe(true);
    }
  });

  it('rejects a non-boolean supersede', () => {
    const result = createInvitationSchema.safeParse({
      playerId: '2c9a4f1e-8b1d-4f6a-9c3e-1a2b3c4d5e6f',
      supersede: 'yes',
    });
    expect(result.success).toBe(false);
  });
});
