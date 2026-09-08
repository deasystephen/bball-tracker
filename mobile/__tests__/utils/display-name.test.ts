/**
 * Display-name helper (#444): a deleted account renders a localized label
 * derived from `deletedAt`, never from the stored name.
 */
import { i18n } from '../../i18n';
import { displayName, isDeletedUser } from '../../utils/display-name';

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
