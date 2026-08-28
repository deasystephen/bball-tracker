/**
 * Chip derivation for the unified roster (unification spec).
 * Mirrors the backend rule: Active = claimed (isManaged false) OR any
 * ACCEPTED invitation; Invited/Expired from the PENDING row; else Not invited.
 */

import {
  getRosterStatus,
  rosterStatusLabel,
  rosterStatusColor,
  type TeamInvitationStatusRow,
} from '../../utils/roster-status';

const NOW = new Date('2026-08-28T12:00:00Z');
const FUTURE = '2026-09-04T12:00:00Z';
const PAST = '2026-08-20T12:00:00Z';

const member = (playerId: string, isManaged: boolean | undefined) => ({
  playerId,
  player: { isManaged },
});

const row = (
  playerId: string,
  status: 'PENDING' | 'ACCEPTED',
  expiresAt: string
): TeamInvitationStatusRow => ({
  id: `inv-${playerId}-${status}`,
  playerId,
  status,
  expiresAt,
  createdAt: '2026-08-27T12:00:00Z',
});

describe('getRosterStatus', () => {
  it('claimed account (isManaged false) is Active regardless of invitations', () => {
    const result = getRosterStatus(member('p1', false), [row('p1', 'PENDING', FUTURE)], NOW);
    expect(result.status).toBe('active');
  });

  it('managed player with an ACCEPTED row is Active (web-link accept, never logged in)', () => {
    const result = getRosterStatus(member('p1', true), [row('p1', 'ACCEPTED', PAST)], NOW);
    expect(result.status).toBe('active');
  });

  it('managed player with a live PENDING row is Invited, exposing the row for cancel', () => {
    const pending = row('p1', 'PENDING', FUTURE);
    const result = getRosterStatus(member('p1', true), [pending], NOW);
    expect(result.status).toBe('invited');
    expect(result.pendingInvitation).toEqual(pending);
  });

  it('managed player with a lapsed PENDING row is Invite expired (client-computed)', () => {
    const result = getRosterStatus(member('p1', true), [row('p1', 'PENDING', PAST)], NOW);
    expect(result.status).toBe('invite_expired');
  });

  it('managed player with no rows is Not invited', () => {
    expect(getRosterStatus(member('p1', true), [], NOW).status).toBe('not_invited');
  });

  it('ignores other players\' rows', () => {
    const result = getRosterStatus(member('p1', true), [row('p2', 'PENDING', FUTURE)], NOW);
    expect(result.status).toBe('not_invited');
  });

  it('undefined invitations (payload stripped for non-managers) never crashes', () => {
    expect(getRosterStatus(member('p1', true), undefined, NOW).status).toBe('not_invited');
  });

  it('undefined isManaged (older payloads) is treated as unclaimed, not Active', () => {
    // isManaged === false is the Active signal; absence must not imply it
    expect(getRosterStatus(member('p1', undefined), [], NOW).status).toBe('not_invited');
  });

  it('ACCEPTED wins over a stray PENDING row for the same player', () => {
    const result = getRosterStatus(
      member('p1', true),
      [row('p1', 'PENDING', FUTURE), row('p1', 'ACCEPTED', PAST)],
      NOW
    );
    expect(result.status).toBe('active');
  });
});

describe('labels and colors', () => {
  const palette = {
    success: '#0f0',
    primary: '#00f',
    warning: '#fa0',
    textSecondary: '#888',
  };

  it.each([
    ['active', 'Active', palette.success],
    ['invited', 'Invited', palette.primary],
    ['invite_expired', 'Invite expired', palette.warning],
    ['not_invited', 'Not invited', palette.textSecondary],
  ] as const)('%s → "%s" in %s', (status, label, color) => {
    expect(rosterStatusLabel(status)).toBe(label);
    expect(rosterStatusColor(status, palette)).toBe(color);
  });
});
