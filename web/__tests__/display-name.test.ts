import { describe, expect, it } from 'vitest';
import { displayName } from '../lib/display-name';
import { STRINGS } from '../lib/strings';

describe('displayName (#814)', () => {
  it('returns the stored name for a live account', () => {
    expect(displayName({ name: 'Coach Carter', deletedAt: null })).toBe('Coach Carter');
    expect(displayName({ name: 'Coach Carter' })).toBe('Coach Carter');
  });

  it('returns the deleted-user label from deletedAt, whatever the stored name says', () => {
    expect(displayName({ name: 'Coach Carter', deletedAt: '2026-10-01T00:00:00.000Z' })).toBe(STRINGS.deletedUser);
  });

  it('returns an empty string for a missing user', () => {
    expect(displayName(null)).toBe('');
    expect(displayName(undefined)).toBe('');
  });
});
