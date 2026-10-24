import { describe, expect, it } from 'vitest';
import { CLIENT_HEADERS, acceptInvitationByTokenUrl, invitationByTokenUrl } from '../lib/api-urls';

describe('by-token invitation URLs', () => {
  it('builds the lookup and accept URLs with the token encoded', () => {
    expect(invitationByTokenUrl('https://api.example.test', 'abc_-123')).toBe(
      'https://api.example.test/api/v1/invitations/by-token/abc_-123',
    );
    expect(acceptInvitationByTokenUrl('https://api.example.test', 'a/b?c')).toBe(
      'https://api.example.test/api/v1/invitations/by-token/a%2Fb%3Fc/accept',
    );
  });
});

describe('X-Hooplings-Client (#964)', () => {
  // The lookup sends it (invite-page.test.tsx) and so does the browser accept
  // (invitation-accept.test.ts), each asserted on the real fetch call.
  it('identifies the site as exactly `web`, the value the API accepts and logs as client', () => {
    expect(CLIENT_HEADERS).toEqual({ 'X-Hooplings-Client': 'web' });
  });
});
