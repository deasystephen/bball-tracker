import { describe, expect, it, vi } from 'vitest';
import { ACCEPT_FALLBACK_ERROR, ACCEPT_NETWORK_ERROR, acceptInvitation } from '../lib/invitation-accept';

const API = 'https://api.example.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('acceptInvitation (the browser "Accept without app")', () => {
  it('POSTs to the encoded accept URL with X-Hooplings-Client: web (#964)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await acceptInvitation(API, 'a/b')).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/v1/invitations/by-token/a%2Fb/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hooplings-Client': 'web' },
    });
  });

  it("shows the API's error message on a 4xx, or the fallback when there is none", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'This invitation has expired' })));
    expect(await acceptInvitation(API, 'tok')).toEqual({ ok: false, message: 'This invitation has expired' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));
    expect(await acceptInvitation(API, 'tok')).toEqual({ ok: false, message: ACCEPT_FALLBACK_ERROR });
  });

  it('reports a network error when the fetch throws or the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await acceptInvitation(API, 'tok')).toEqual({ ok: false, message: ACCEPT_NETWORK_ERROR });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 502 })));
    expect(await acceptInvitation(API, 'tok')).toEqual({ ok: false, message: ACCEPT_NETWORK_ERROR });
  });
});
