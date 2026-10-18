import { describe, expect, it } from 'vitest';
import { childDisplayName, displayName, inviterDisplayName } from '../lib/display-name';
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

describe('flattened payload helpers (#894)', () => {
  const deletedAt = '2026-10-01T00:00:00.000Z';

  it('labels the child from childDeletedAt', () => {
    expect(childDisplayName({ childName: 'Sam', childDeletedAt: null })).toBe('Sam');
    expect(childDisplayName({ childName: 'Sam' })).toBe('Sam');
    expect(childDisplayName({ childName: 'Sam', childDeletedAt: deletedAt })).toBe(STRINGS.deletedUser);
  });

  it('labels the inviter from inviterDeletedAt', () => {
    expect(inviterDisplayName({ inviterName: 'Coach', inviterDeletedAt: null })).toBe('Coach');
    expect(inviterDisplayName({ inviterName: 'Coach', inviterDeletedAt: deletedAt })).toBe(STRINGS.deletedUser);
  });
});
