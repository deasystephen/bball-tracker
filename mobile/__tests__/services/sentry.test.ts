/**
 * Tests for services/sentry.ts
 *
 * Verifies:
 *   - init is gated on a DSN being present
 *   - init is idempotent
 *   - beforeSend scrubs sensitive fields across request/extra/contexts/breadcrumbs
 *   - setSentryUser no-ops until init has run
 */

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  setUser: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {},
      version: '1.2.3',
    },
  },
}));

const sentryInit = Sentry.init as jest.Mock;
const sentrySetUser = Sentry.setUser as jest.Mock;
const sentryCaptureException = Sentry.captureException as jest.Mock;

// Each test re-imports the module so the `initialized` module-level flag
// starts fresh.
function loadSentryModule() {
  let mod!: typeof import('../../services/sentry');
  jest.isolateModules(() => {
    mod = jest.requireActual<typeof import('../../services/sentry')>(
      '../../services/sentry'
    );
  });
  return mod;
}

function setExtra(extra: Record<string, unknown> | undefined): void {
  (Constants as unknown as { expoConfig: { extra: unknown } }).expoConfig.extra =
    extra;
}

describe('services/sentry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setExtra({});
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
  });

  describe('initSentry', () => {
    it('no-ops when no DSN is configured', () => {
      const { initSentry, isSentryEnabled } = loadSentryModule();
      initSentry();
      expect(sentryInit).not.toHaveBeenCalled();
      expect(isSentryEnabled()).toBe(false);
    });

    it('initializes Sentry when DSN is in expoConfig extras', () => {
      setExtra({
        sentryDsn: 'https://test@sentry.io/1',
        sentryEnvironment: 'staging',
      });
      const { initSentry, isSentryEnabled } = loadSentryModule();
      initSentry();
      expect(sentryInit).toHaveBeenCalledTimes(1);
      const cfg = sentryInit.mock.calls[0][0];
      expect(cfg.dsn).toBe('https://test@sentry.io/1');
      expect(cfg.environment).toBe('staging');
      expect(cfg.sendDefaultPii).toBe(false);
      expect(typeof cfg.beforeSend).toBe('function');
      expect(isSentryEnabled()).toBe(true);
    });

    it('falls back to SENTRY_DSN env var', () => {
      process.env.SENTRY_DSN = 'https://env@sentry.io/2';
      const { initSentry } = loadSentryModule();
      initSentry();
      expect(sentryInit).toHaveBeenCalledTimes(1);
      expect(sentryInit.mock.calls[0][0].dsn).toBe('https://env@sentry.io/2');
    });

    it('is idempotent across multiple calls', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      const { initSentry } = loadSentryModule();
      initSentry();
      initSentry();
      initSentry();
      expect(sentryInit).toHaveBeenCalledTimes(1);
    });

    it('uses sentryRelease from extras when provided', () => {
      setExtra({
        sentryDsn: 'https://test@sentry.io/1',
        sentryRelease: 'my-release-1',
      });
      const { initSentry } = loadSentryModule();
      initSentry();
      expect(sentryInit.mock.calls[0][0].release).toBe('my-release-1');
    });

    it('falls back to version from expoConfig when no release set', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      const { initSentry } = loadSentryModule();
      initSentry();
      expect(sentryInit.mock.calls[0][0].release).toBe('1.2.3');
    });

    it('stays disabled when Sentry.init throws', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      sentryInit.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { initSentry, isSentryEnabled } = loadSentryModule();
        initSentry();
        expect(isSentryEnabled()).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('beforeSend', () => {
    it('scrubs sensitive headers, cookies, and request body', () => {
      const { beforeSend } = loadSentryModule();
      const out = beforeSend({
        request: {
          headers: { Authorization: 'Bearer abc', 'X-Safe': 'ok' },
          cookies: { session: 'secret', other: 'fine' },
          data: { password: 'hunter2' },
        },
      } as unknown as Parameters<typeof beforeSend>[0]);

      expect(out.request?.headers).toEqual({
        Authorization: '[scrubbed]',
        'X-Safe': 'ok',
      });
      expect(out.request?.cookies).toEqual({
        session: '[scrubbed]',
        other: 'fine',
      });
      expect(out.request?.data).toBe('[scrubbed]');
    });

    it('scrubs extra and contexts fields recursively', () => {
      const { beforeSend } = loadSentryModule();
      const out = beforeSend({
        extra: {
          email: 'user@example.com',
          nested: { token: 'xyz', keep: 1 },
        },
        contexts: {
          user_ctx: { jwt: 'abc', id: 'u1' },
        },
      } as unknown as Parameters<typeof beforeSend>[0]);

      expect((out.extra as Record<string, unknown>).email).toBe('[scrubbed]');
      expect(
        (
          (out.extra as Record<string, unknown>).nested as Record<string, unknown>
        ).token
      ).toBe('[scrubbed]');
      expect(
        ((out.extra as Record<string, unknown>).nested as Record<string, unknown>)
          .keep
      ).toBe(1);
      expect(
        (
          (out.contexts as Record<string, unknown>).user_ctx as Record<
            string,
            unknown
          >
        ).jwt
      ).toBe('[scrubbed]');
    });

    it('scrubs breadcrumb data', () => {
      const { beforeSend } = loadSentryModule();
      const out = beforeSend({
        breadcrumbs: [
          { message: 'login', data: { password: 'p' } },
          { message: 'visit', data: { url: '/home' } },
          { message: 'no-data' },
        ],
      } as unknown as Parameters<typeof beforeSend>[0]);

      expect(out.breadcrumbs?.[0].data?.password).toBe('[scrubbed]');
      expect(out.breadcrumbs?.[1].data?.url).toBe('/home');
      expect(out.breadcrumbs?.[2].data).toBeUndefined();
    });

    // Audit #15: XHR breadcrumbs carry the URL under `data.url`; the key-name
    // scrub never touched it, so `?code=` and `/by-token/<t>` shipped to Sentry.
    it('redacts breadcrumb data.url by value (OAuth code, by-token segment)', () => {
      const { beforeSend } = loadSentryModule();
      const out = beforeSend({
        breadcrumbs: [
          {
            category: 'xhr',
            data: {
              url: 'https://api.capyhoops.com/api/v1/auth/callback?code=OAUTHCODE&state=ST',
              method: 'GET',
              status_code: 200,
            },
          },
          {
            category: 'xhr',
            data: { url: 'https://api.capyhoops.com/api/v1/invitations/by-token/abcdef0123456789' },
          },
          {
            category: 'navigation',
            data: { from: '/invite/abcdef0123456789', to: '/login' },
          },
        ],
      } as unknown as Parameters<typeof beforeSend>[0]);

      expect(out.breadcrumbs?.[0].data?.url).toBe(
        'https://api.capyhoops.com/api/v1/auth/callback?code=[scrubbed]&state=[scrubbed]'
      );
      expect(out.breadcrumbs?.[0].data?.method).toBe('GET');
      expect(out.breadcrumbs?.[1].data?.url).toBe(
        'https://api.capyhoops.com/api/v1/invitations/by-token/[scrubbed]'
      );
      expect(out.breadcrumbs?.[2].data?.from).toBe('/invite/[scrubbed]');
      expect(out.breadcrumbs?.[2].data?.to).toBe('/login');
      expect(JSON.stringify(out)).not.toMatch(/OAUTHCODE|abcdef0123456789/);
    });

    it('redacts request.url, request.query_string and transaction', () => {
      const { beforeSend } = loadSentryModule();
      const out = beforeSend({
        transaction: '/api/v1/teams/t1/calendar.ics?token=CALTOKEN',
        request: {
          url: 'https://api.capyhoops.com/api/v1/teams/t1/calendar/abcdef0123456789?token=CALTOKEN',
          query_string: 'token=CALTOKEN&page=1',
        },
      } as unknown as Parameters<typeof beforeSend>[0]);
      expect(out.request?.url).toBe(
        'https://api.capyhoops.com/api/v1/teams/t1/calendar/[scrubbed]?token=[scrubbed]'
      );
      expect(out.request?.query_string).toBe('token=[scrubbed]&page=1');
      expect(out.transaction).toBe('/api/v1/teams/t1/calendar.ics?token=[scrubbed]');
    });

    it('registers beforeSendTransaction at init', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      const { initSentry } = loadSentryModule();
      initSentry();
      const cfg = sentryInit.mock.calls[0][0];
      expect(typeof cfg.beforeSendTransaction).toBe('function');
      const out = cfg.beforeSendTransaction({
        transaction: '/api/v1/auth/callback?code=OAUTHCODE',
      });
      expect(out.transaction).toBe('/api/v1/auth/callback?code=[scrubbed]');
    });

    it('returns the event untouched when no sensitive fields present', () => {
      const { beforeSend } = loadSentryModule();
      const event = { message: 'hi', tags: { env: 'test' } };
      const out = beforeSend(event as unknown as Parameters<typeof beforeSend>[0]);
      expect(out).toEqual(event);
    });

    it('handles arrays within scrubbed objects', () => {
      const { beforeSend } = loadSentryModule();
      const out = beforeSend({
        extra: {
          items: [{ token: 't1' }, { safe: 'ok' }],
        },
      } as unknown as Parameters<typeof beforeSend>[0]);
      const items = (out.extra as { items: Record<string, unknown>[] })
        .items;
      expect(items[0].token).toBe('[scrubbed]');
      expect(items[1].safe).toBe('ok');
    });
  });

  describe('redactUrl', () => {
    it('masks sensitive query values and secret path segments, keeps the rest', () => {
      const { redactUrl } = loadSentryModule();
      expect(redactUrl('/api/v1/games?page=1&status=LIVE')).toBe('/api/v1/games?page=1&status=LIVE');
      expect(redactUrl('/api/v1/auth/refresh?refresh_token=R')).toBe('/api/v1/auth/refresh?refresh_token=[scrubbed]');
      expect(redactUrl('/api/v1/teams/t1/calendar/subscribe')).toBe('/api/v1/teams/t1/calendar/subscribe');
      expect(redactUrl('https://capyhoops.com/invite/abcdef0123456789#x')).toBe(
        'https://capyhoops.com/invite/[scrubbed]'
      );
      expect(redactUrl('')).toBe('');
    });
  });

  describe('setSentryUser', () => {
    it('no-ops when Sentry is not initialized', () => {
      const { setSentryUser } = loadSentryModule();
      setSentryUser('u1');
      expect(sentrySetUser).not.toHaveBeenCalled();
    });

    it('sets user after init', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      const { initSentry, setSentryUser } = loadSentryModule();
      initSentry();
      setSentryUser('u1');
      expect(sentrySetUser).toHaveBeenCalledWith({ id: 'u1' });
    });

    it('clears user when passed null', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      const { initSentry, setSentryUser } = loadSentryModule();
      initSentry();
      setSentryUser(null);
      expect(sentrySetUser).toHaveBeenCalledWith(null);
    });

    it('swallows errors from Sentry.setUser', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      sentrySetUser.mockImplementationOnce(() => {
        throw new Error('nope');
      });
      const { initSentry, setSentryUser } = loadSentryModule();
      initSentry();
      expect(() => setSentryUser('u1')).not.toThrow();
    });
  });

  describe('captureException', () => {
    it('no-ops when Sentry is not initialized', () => {
      const { captureException } = loadSentryModule();
      captureException(new Error('boom'));
      expect(sentryCaptureException).not.toHaveBeenCalled();
    });

    it('forwards the error to Sentry after init', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      const { initSentry, captureException } = loadSentryModule();
      initSentry();
      const err = new Error('boom');
      captureException(err);
      expect(sentryCaptureException).toHaveBeenCalledWith(err, undefined);
    });

    it('attaches context under the app namespace when provided', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      const { initSentry, captureException } = loadSentryModule();
      initSentry();
      const err = new Error('boom');
      captureException(err, { flow: 'auth-callback' });
      expect(sentryCaptureException).toHaveBeenCalledWith(err, {
        contexts: { app: { flow: 'auth-callback' } },
      });
    });

    it('swallows errors from Sentry.captureException', () => {
      setExtra({ sentryDsn: 'https://test@sentry.io/1' });
      sentryCaptureException.mockImplementationOnce(() => {
        throw new Error('nope');
      });
      const { initSentry, captureException } = loadSentryModule();
      initSentry();
      expect(() => captureException(new Error('boom'))).not.toThrow();
    });
  });
});
