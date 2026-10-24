import { readFileSync } from 'fs';
import path from 'path';
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
  it('identifies the site as exactly `web`, the value the API accepts and logs as client', () => {
    expect(CLIENT_HEADERS).toEqual({ 'X-Hooplings-Client': 'web' });
  });

  it('is sent by the browser accept as well as the server lookup', () => {
    // The accept runs in a client component the node test environment does not
    // render; pin the fetch call's headers in its source instead.
    const source = readFileSync(path.join(__dirname, '../app/invite/[token]/invite-client.tsx'), 'utf8');
    expect(source).toMatch(
      /fetch\(acceptInvitationByTokenUrl\(API_URL, token\), \{[^}]*headers: \{ 'Content-Type': 'application\/json', \.\.\.CLIENT_HEADERS \}/,
    );
  });
});
