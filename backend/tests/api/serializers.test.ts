/**
 * Shared secret-stripping serializer (route-layer defense in depth, audit #14).
 */

import { omitSecret } from '../../src/api/serializers';
import { omitToken } from '../../src/api/invitations/serializers';

describe('omitSecret', () => {
  it('returns a copy without the named key and leaves the input untouched', () => {
    const row = { id: 'i1', token: 'secret', status: 'PENDING' };

    const out = omitSecret(row, 'token');

    expect(out).toEqual({ id: 'i1', status: 'PENDING' });
    expect('token' in out).toBe(false);
    expect(row.token).toBe('secret');
  });

  it('returns the same object when the key is absent (no needless copy on lists)', () => {
    const row = { id: 'i1', status: 'PENDING' };

    expect(omitSecret(row, 'token')).toBe(row);
  });

  it('strips any secret name, not only "token"', () => {
    const row = { id: 'c1', name: 'Metro Fall', joinCode: 'ABCD-EFGH' };

    expect(omitSecret(row, 'joinCode')).toEqual({ id: 'c1', name: 'Metro Fall' });
  });

  it('strips a key whose value is null or empty (presence, not truthiness)', () => {
    expect(omitSecret({ id: 'i1', token: null }, 'token')).toEqual({ id: 'i1' });
    expect(omitSecret({ id: 'i1', token: '' }, 'token')).toEqual({ id: 'i1' });
  });
});

describe('omitToken', () => {
  it('is the "token" specialisation of omitSecret', () => {
    const invitation = { id: 'i1', token: 'secret', playerId: 'p1' };

    expect(omitToken(invitation)).toEqual({ id: 'i1', playerId: 'p1' });
    expect(omitToken([invitation].map(omitToken)[0])).toEqual({ id: 'i1', playerId: 'p1' });
  });
});
