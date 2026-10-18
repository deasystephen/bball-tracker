import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InvitePage from '../app/invite/[token]/page';
import type { GuardianInvitationDetails, TeamInvitationDetails } from '../lib/invitation-types';
import { getInvitation } from '../lib/invitation-lookup';
import { STRINGS } from '../lib/strings';

const TOKEN = 'abcDEF123_-xyz';
const RESEND_COPY = 'ask the team coach to resend';

function future(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function teamInvitation(overrides: Partial<TeamInvitationDetails> = {}): TeamInvitationDetails {
  return {
    kind: 'team',
    id: 'inv-1',
    status: 'PENDING',
    teamName: 'Rockets',
    inviterName: 'Coach Carter',
    inviterDeletedAt: null,
    position: null,
    jerseyNumber: null,
    message: null,
    expiresAt: future(),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await InvitePage({ params: Promise.resolve({ token: TOKEN }) }));
}

describe('invite page lookup states (#720)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('API_URL', 'https://api.example.test');
  });

  it.each([400, 404])('renders Invitation Not Found with the resend footer for %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { error: 'Invitation not found' })));
    const html = await renderPage();
    expect(html).toContain('Invitation Not Found');
    expect(html).toContain(RESEND_COPY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders the unavailable card with wait copy for 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: 'Too many requests' })));
    const html = await renderPage();
    expect(html).toContain('Invitation Temporarily Unavailable');
    expect(html).toContain('Please wait a few minutes and try again');
    // Either limiter (per token or per IP) can trip, so the copy makes no per-link claim.
    expect(html).not.toContain('this link');
    expect(html).not.toContain('Invitation Not Found');
    expect(html).not.toContain('resend');
  });

  it.each([500, 502, 503])('renders the unavailable card for %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { error: 'Failed' })));
    const html = await renderPage();
    expect(html).toContain('Invitation Temporarily Unavailable');
    expect(html).toContain('try again in a few minutes');
    expect(html).not.toContain('too many requests');
    expect(html).not.toContain('resend');
  });

  it('renders the unavailable card when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const html = await renderPage();
    expect(html).toContain('Invitation Temporarily Unavailable');
    expect(html).not.toContain('resend');
  });

  it('renders the unavailable card for a non-JSON 2xx body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 200 })));
    const html = await renderPage();
    expect(html).toContain('Invitation Temporarily Unavailable');
    expect(html).not.toContain('resend');
  });

  it('renders InviteClient for a 2xx with an invitation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { success: true, invitation: teamInvitation() })));
    const html = await renderPage();
    expect(html).toContain('invited to join a team');
    expect(html).toContain('Rockets');
    expect(html).toContain('Open in App');
  });

  it('logs the unavailable status without the URL or the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, {})));
    await renderPage();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Invitation lookup unavailable', { reason: 'status', status: 503 });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('api.example.test');
  });

  it.each([
    ['network', () => vi.fn().mockRejectedValue(new TypeError('fetch failed')), null],
    ['body', () => vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 200 })), 200],
    ['body', () => vi.fn().mockResolvedValue(jsonResponse(200, { success: true })), 200],
    ['status', () => vi.fn().mockResolvedValue(jsonResponse(500, {})), 500],
  ] as const)('logs reason %s for an unavailable lookup', async (reason, makeFetch, status) => {
    vi.stubGlobal('fetch', makeFetch());
    await getInvitation(TOKEN);
    expect(warn).toHaveBeenCalledWith('Invitation lookup unavailable', { reason, status });
  });

  it('requests the by-token URL with the token encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    vi.stubGlobal('fetch', fetchMock);
    await getInvitation('a/b');
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/v1/invitations/by-token/a%2Fb', {
      cache: 'no-store',
    });
  });

  it('maps statuses to the discriminated LookupResult', async () => {
    const cases: [Response | Error, Awaited<ReturnType<typeof getInvitation>>['kind'], number | undefined][] = [
      [jsonResponse(404, {}), 'notFound', undefined],
      [jsonResponse(429, {}), 'unavailable', 429],
      [jsonResponse(500, {}), 'unavailable', 500],
      [new TypeError('fetch failed'), 'unavailable', undefined],
    ];
    for (const [outcome, kind, status] of cases) {
      vi.stubGlobal(
        'fetch',
        outcome instanceof Error ? vi.fn().mockRejectedValue(outcome) : vi.fn().mockResolvedValue(outcome),
      );
      const result = await getInvitation(TOKEN);
      expect(result.kind).toBe(kind);
      if (result.kind === 'unavailable') expect(result.status).toBe(status);
    }
  });
});

describe('invite page inviter tombstone (#814)', () => {
  it('shows the stored inviter name for a live sender', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { success: true, invitation: teamInvitation() })));
    const html = await renderPage();
    expect(html).toContain('Coach Carter');
    expect(html).not.toContain(STRINGS.deletedUser);
  });

  it('shows the deleted-user label, never the stored name, when inviterDeletedAt is set', async () => {
    const invitation = teamInvitation({
      inviterName: 'Stored Literal Name',
      inviterDeletedAt: '2026-10-01T00:00:00.000Z',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { success: true, invitation })));
    const html = await renderPage();
    expect(html).toContain(STRINGS.deletedUser);
    expect(html).not.toContain('Stored Literal Name');
  });

  it('labels a guardian invitation inviter from inviterDeletedAt when present', async () => {
    const invitation: GuardianInvitationDetails = {
      kind: 'guardian',
      id: 'ginv-1',
      status: 'PENDING',
      childName: 'Sam',
      childDeletedAt: null,
      teamName: null,
      inviterName: 'Stored Literal Name',
      inviterDeletedAt: '2026-10-01T00:00:00.000Z',
      relationship: 'MOTHER',
      expiresAt: future(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { success: true, invitation })));
    const html = await renderPage();
    expect(html).toContain(STRINGS.deletedUser);
    expect(html).not.toContain('Stored Literal Name');
  });

  it('labels a tombstoned child from childDeletedAt, never the stored name (#894)', async () => {
    const invitation: GuardianInvitationDetails = {
      kind: 'guardian',
      id: 'ginv-2',
      status: 'PENDING',
      childName: 'Stored Child Literal',
      childDeletedAt: '2026-10-01T00:00:00.000Z',
      teamName: null,
      inviterName: 'Coach Carter',
      inviterDeletedAt: null,
      relationship: 'FATHER',
      expiresAt: future(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { success: true, invitation })));
    const html = await renderPage();
    expect(html).toContain(STRINGS.deletedUser);
    expect(html).not.toContain('Stored Child Literal');
  });
});
