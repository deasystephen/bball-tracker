import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JoinPage from '../app/join/[token]/page';
import { getJoinLink } from '../lib/join-lookup';

const TOKEN = 'joinTOKEN123_-abcdefghijklmnop';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The `Join link lookup unavailable` lines lib/log.ts printed, parsed. */
function lookupLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((entry: Record<string, unknown>) => entry.message === 'Join link lookup unavailable');
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await JoinPage({ params: Promise.resolve({ token: TOKEN }) }));
}

describe('join page (#210)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // lib/log.ts writes warn lines to stdout as JSON.
    warn = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('API_URL', 'https://api.example.test');
  });

  it('an active link names the team, says a coach approves, and offers only Open in App', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, link: { teamName: 'Rockets', state: 'active' } }));
    vi.stubGlobal('fetch', fetchMock);

    const html = await renderPage();

    expect(html).toContain('Join Rockets');
    expect(html).toContain('A coach approves each request before anyone');
    expect(html).toContain('Children don&#x27;t get their own');
    expect(html).toContain('Open in App');
    // Nothing can be accepted on the web: joining needs a signed-in adult in the app.
    expect(html).not.toContain('without app');
    // The token is in no markup: the button builds the deep link on click.
    expect(html).not.toContain(TOKEN);
  });

  it('looks the link up on the public join route, identified as the web client, without caching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, link: { teamName: 'Rockets', state: 'active' } }));
    vi.stubGlobal('fetch', fetchMock);

    await renderPage();

    expect(fetchMock).toHaveBeenCalledWith(`https://api.example.test/api/v1/join/${TOKEN}`, {
      cache: 'no-store',
      headers: { 'X-Hooplings-Client': 'web' },
    });
  });

  it.each([
    ['expired', 'Join Link Expired'],
    ['full', 'Join Link Is Full'],
  ])('a link that is %s says so, names the team and offers no button', async (state, title) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { success: true, link: { teamName: 'Rockets', state } })));

    const html = await renderPage();

    expect(html).toContain(title);
    expect(html).toContain('<strong>Rockets</strong> no longer takes requests');
    expect(html).toContain('Ask the team coach for a new join link.');
    expect(html).not.toContain('Open in App');
  });

  it.each([400, 404])('renders Join Link Not Found for %i (unknown, or replaced by the coach)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { error: 'Join link not found' })));

    const html = await renderPage();

    expect(html).toContain('Join Link Not Found');
    expect(html).toContain('current join link');
    expect(html).not.toContain('Open in App');
    expect(lookupLines(warn)).toHaveLength(0);
  });

  it.each([429, 500, 503])('renders Temporarily Unavailable for %i and never says the link is dead', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { error: 'x' })));

    const html = await renderPage();

    expect(html).toContain('Join Link Temporarily Unavailable');
    expect(html).toContain('Your join link may still be valid.');
    expect(html).not.toContain('Join Link Not Found');
    expect(lookupLines(warn)).toEqual([expect.objectContaining({ reason: 'status', status })]);
  });

  it('a failed fetch is unavailable, and the log line carries neither the URL nor the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError(`fetch failed: https://api.example.test/api/v1/join/${TOKEN}`))
    );

    const result = await getJoinLink(TOKEN);

    expect(result).toEqual({ kind: 'unavailable', status: undefined });
    expect(lookupLines(warn)).toEqual([expect.objectContaining({ reason: 'network', status: null })]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it.each([
    ['no link in the body', { success: true }],
    ['an unknown state', { success: true, link: { teamName: 'Rockets', state: 'revoked' } }],
    ['no team name', { success: true, link: { state: 'active' } }],
  ])('a 200 with %s is unavailable, not a page built on a guess', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, body)));

    expect(await getJoinLink(TOKEN)).toEqual({ kind: 'unavailable', status: 200 });
    expect(lookupLines(warn)).toEqual([expect.objectContaining({ reason: 'body', status: 200 })]);
  });

  it('a 200 that is not JSON is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));

    expect(await getJoinLink(TOKEN)).toEqual({ kind: 'unavailable', status: 200 });
  });
});

describe('apple-app-site-association (#210)', () => {
  it('hands /join/* to the app as well as /invite/*', () => {
    const aasa = JSON.parse(
      readFileSync(resolve(__dirname, '../public/.well-known/apple-app-site-association'), 'utf8')
    ) as { applinks: { details: { components: { '/': string }[] }[] } };

    const paths = aasa.applinks.details.flatMap((detail) => detail.components.map((component) => component['/']));
    expect(paths).toEqual(['/invite/*', '/join/*']);
  });
});
