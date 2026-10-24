import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_SERVICE, REDACTED, buildEntry, deployedCommit, log, redactText } from '../lib/log';

// A realistic invitation token (url-safe, the API's alphabet) and a commit id.
const TOKEN = 'Zq3x9_K-v7LmN2pR8sT4uW6yA1bC5dE0';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function printed(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe('lib/log (#966)', () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('GIT_COMMIT', COMMIT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes one JSON object per line with service and commit; error goes to stderr', () => {
    log.info('i', { status: 200 });
    log.warn('w');
    log.error('e', { routePath: '/invite/[token]' });

    expect(printed(out)).toHaveLength(2);
    expect(printed(err)).toHaveLength(1);
    for (const line of [...printed(out), ...printed(err)]) {
      expect(line).not.toContain('\n');
      expect(JSON.parse(line)).toEqual(
        expect.objectContaining({ service: LOG_SERVICE, commit: COMMIT, timestamp: expect.any(String) })
      );
    }
    expect(JSON.parse(printed(out)[0])).toEqual(expect.objectContaining({ level: 'info', message: 'i', status: 200 }));
    expect(JSON.parse(printed(err)[0])).toEqual(expect.objectContaining({ level: 'error', routePath: '/invite/[token]' }));
  });

  it('never lets a context key overwrite service or commit', () => {
    expect(buildEntry('info', 'm', { service: 'spoofed', commit: 'spoofed' })).toEqual(
      expect.objectContaining({ service: 'bball-tracker-web', commit: COMMIT })
    );
  });

  it('writes commit null when GIT_COMMIT is unset or still the placeholder', () => {
    expect(deployedCommit({})).toBeNull();
    expect(deployedCommit({ GIT_COMMIT: 'GIT_COMMIT_PLACEHOLDER' })).toBeNull();
    expect(deployedCommit({ GIT_COMMIT: ` ${COMMIT} ` })).toBe(COMMIT);
  });

  describe('a token never reaches the output', () => {
    it.each([
      ['an invite page path', `/invite/${TOKEN}`],
      ['an absolute invite URL', `https://hooplings.com/invite/${TOKEN}?utm=x`],
      ['the lookup URL in an undici error', `Failed to parse URL from https://api.hooplings.com/api/v1/invitations/by-token/${TOKEN}`],
      ['the accept URL', `POST https://api.hooplings.com/api/v1/invitations/by-token/${TOKEN}/accept failed`],
      ['the app deep link', `hooplings://invite/${TOKEN}?src=web`],
      ['a calendar feed URL', `https://api.hooplings.com/api/v1/calendar/${TOKEN}.ics`],
      ['a token query parameter', `https://api.hooplings.com/feed?token=${TOKEN}&x=1`],
      ['an OAuth code', `/auth/callback?code=${TOKEN}&state=${TOKEN}`],
    ])('masks %s in the message and in a context value', (_label, text) => {
      log.error(text, { detail: text });
      const line = printed(err)[0];

      expect(line).not.toContain(TOKEN);
      expect(line).toContain(REDACTED);
    });

    it('masks a context key that names a secret, whatever its value', () => {
      log.info('m', { token: TOKEN, inviteToken: 'short', authorization: `Bearer ${TOKEN}` });
      const entry = JSON.parse(printed(out)[0]);

      expect(printed(out)[0]).not.toContain(TOKEN);
      expect(entry).toEqual(expect.objectContaining({ token: REDACTED, inviteToken: REDACTED, authorization: REDACTED }));
    });
  });

  describe('redactText', () => {
    it('keeps route patterns, which carry no value', () => {
      expect(redactText('/invite/[token]')).toBe('/invite/[token]');
      expect(redactText('/api/v1/invitations/by-token/[token]/accept')).toBe('/api/v1/invitations/by-token/[token]/accept');
    });

    it('masks only the segment after the secret parent and keeps the rest', () => {
      expect(redactText(`/api/v1/invitations/by-token/${TOKEN}/accept`)).toBe(
        `/api/v1/invitations/by-token/${REDACTED}/accept`
      );
      expect(redactText('/support')).toBe('/support');
      expect(redactText('/health?verbose=1')).toBe('/health?verbose=1');
    });

    it('masks a bracketed segment that is not the whole segment', () => {
      expect(redactText(`/invite/[x]${TOKEN}`)).not.toContain(TOKEN);
    });
  });
});
