import { getJerseyConflict } from '../../utils/jersey-conflict';

describe('getJerseyConflict (#1087)', () => {
  const body = {
    status: 409,
    code: 'jersey_number_taken',
    jerseyNumber: 0,
    playerId: 'p1',
    playerName: 'Ada',
    playerDeletedAt: null,
  };

  it('reads the holder off a 409 jersey_number_taken, jersey 0 included', () => {
    expect(getJerseyConflict({ apiError: body })).toEqual({
      jerseyNumber: 0,
      playerId: 'p1',
      playerName: 'Ada',
      playerDeletedAt: null,
    });
  });

  it('carries a deleted holder\'s timestamp', () => {
    expect(getJerseyConflict({ apiError: { ...body, playerDeletedAt: '2026-11-01T00:00:00Z' } })?.playerDeletedAt).toBe(
      '2026-11-01T00:00:00Z'
    );
  });

  it('is null for any other error or a malformed body', () => {
    expect(getJerseyConflict(new Error('boom'))).toBeNull();
    expect(getJerseyConflict({ apiError: { ...body, code: 'player_has_records' } })).toBeNull();
    expect(getJerseyConflict({ apiError: { ...body, jerseyNumber: '8' } })).toBeNull();
    expect(getJerseyConflict(undefined)).toBeNull();
  });
});
