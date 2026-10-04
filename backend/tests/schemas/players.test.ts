/**
 * Player schemas store an address in the form every account-creating path
 * uses: trimmed and lower-cased (#651). WorkOS presents lower-case addresses
 * and `syncUser` claims a pre-provisioned row by exact match, so a mixed-case
 * row would be an unclaimable duplicate.
 */
import { createPlayerSchema, updatePlayerSchema } from '../../src/api/players/schemas';

describe('createPlayerSchema.email (#651)', () => {
  it('trims and lower-cases before validating', () => {
    const parsed = createPlayerSchema.parse({ email: '  Jordan.Smith@Example.com ', name: 'Jordan' });
    expect(parsed.email).toBe('jordan.smith@example.com');
  });

  it('rejects a malformed address after trimming', () => {
    const result = createPlayerSchema.safeParse({ email: '   not-an-email ', name: 'Jordan' });
    expect(result.success).toBe(false);
  });

  it('rejects an address longer than 255 characters', () => {
    const result = createPlayerSchema.safeParse({ email: `${'a'.repeat(250)}@example.com`, name: 'Jordan' });
    expect(result.success).toBe(false);
  });

  it('accepts an address of exactly 255 characters', () => {
    const email = `${'a'.repeat(243)}@example.com`;
    expect(email).toHaveLength(255);
    expect(createPlayerSchema.safeParse({ email, name: 'Jordan' }).success).toBe(true);
  });

  it('still requires the address', () => {
    expect(createPlayerSchema.safeParse({ name: 'Jordan' }).success).toBe(false);
  });
});

describe('updatePlayerSchema.email (#651)', () => {
  it('trims and lower-cases before validating', () => {
    const parsed = updatePlayerSchema.parse({ email: ' Jordan.Smith@Example.COM' });
    expect(parsed.email).toBe('jordan.smith@example.com');
  });

  it('stays optional', () => {
    const parsed = updatePlayerSchema.parse({ name: 'Jordan' });
    expect(parsed.email).toBeUndefined();
  });

  it('rejects a malformed or over-long address', () => {
    expect(updatePlayerSchema.safeParse({ email: 'nope' }).success).toBe(false);
    expect(updatePlayerSchema.safeParse({ email: `${'a'.repeat(250)}@example.com` }).success).toBe(false);
  });
});
