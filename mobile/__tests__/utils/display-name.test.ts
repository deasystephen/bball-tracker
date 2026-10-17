/**
 * Display-name helper (#444): a deleted account renders a localized label
 * derived from `deletedAt`, never from the stored name.
 */
import { i18n } from '../../i18n';
import {
  childDisplayName,
  displayName,
  inviterDisplayName,
  isDeletedUser,
  playerDisplayName,
} from '../../utils/display-name';

describe('displayName', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('returns the stored name for a live account (deletedAt absent or null)', () => {
    expect(displayName({ name: 'Steph Curry' })).toBe('Steph Curry');
    expect(displayName({ name: 'Steph Curry', deletedAt: null })).toBe('Steph Curry');
    expect(isDeletedUser({ name: 'Steph Curry', deletedAt: null })).toBe(false);
  });

  it('returns the localized "Deleted user" label whenever deletedAt is set, ignoring the stored name', async () => {
    const gone = { name: 'Deleted user', deletedAt: '2026-09-07T00:00:00Z' };
    expect(isDeletedUser(gone)).toBe(true);
    expect(displayName(gone)).toBe('Deleted user');
    expect(displayName({ name: 'Still Here', deletedAt: '2026-09-07T00:00:00Z' })).toBe('Deleted user');

    await i18n.changeLanguage('es');
    expect(displayName(gone)).toBe('Usuario eliminado');
  });

  it('is safe on null/undefined', () => {
    expect(displayName(null)).toBe('');
    expect(displayName(undefined)).toBe('');
    expect(isDeletedUser(undefined)).toBe(false);
  });
});

describe('flattened name helpers (#813)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('read the name beside its tombstone timestamp', async () => {
    await i18n.changeLanguage('es');
    const at = '2026-09-01T00:00:00.000Z';
    expect(inviterDisplayName({ inviterName: 'Deleted user', inviterDeletedAt: at })).toBe('Usuario eliminado');
    expect(childDisplayName({ childName: 'Deleted user', childDeletedAt: at })).toBe('Usuario eliminado');
    expect(playerDisplayName({ playerName: 'Deleted user', playerDeletedAt: at })).toBe('Usuario eliminado');
  });

  it('fall back to the stored name when the timestamp is null or absent (older API)', () => {
    expect(inviterDisplayName({ inviterName: 'Steve Kerr', inviterDeletedAt: null })).toBe('Steve Kerr');
    expect(childDisplayName({ childName: 'Steph Curry' })).toBe('Steph Curry');
    expect(playerDisplayName({ playerName: 'John Doe' })).toBe('John Doe');
  });
});
