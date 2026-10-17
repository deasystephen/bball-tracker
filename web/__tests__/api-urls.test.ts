import { describe, expect, it } from 'vitest';
import { acceptInvitationByTokenUrl, invitationByTokenUrl } from '../lib/api-urls';

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
