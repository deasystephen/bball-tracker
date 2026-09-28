/**
 * Ending a session must not set off a burst of requests (#582).
 *
 * Found by `.maestro/account-delete.yaml`: after `DELETE /auth/me` the backend
 * logged `GET /auth/me/usage` about 100 times in two seconds (401, then 429),
 * which spent the IP's rate limit and refused the next sign-in.
 *
 *   clearSession ─► queryClient.clear() ─► a still-mounted query refetches,
 *        ▲                                  now with no token
 *        │                                          │
 *        └──── interceptor: 401, nothing to refresh ◄┘
 *
 * Everything in that loop is real here: the api-client and its interceptors,
 * the auth store, the app's query client and the logout side effects. Only
 * the network is replaced, by an axios adapter that records each request. A
 * test that mocked the api-client could not see the loop at all.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, waitFor, act } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '../../services/api-client';
import { queryClient } from '../../services/query-client';
// Imported for its effect: it registers the logout side effects on the store.
import '../../services/session-logout';
import { useAuthStore } from '../../store/auth-store';
import { useUsage } from '../../hooks/useUsage';

// Hoisted above the imports by babel-jest. jest.setup.js mocks the api-client
// for every suite; this one needs the real one.
jest.unmock('../../services/api-client');
jest.mock('../../services/socket', () => ({ resetSocket: jest.fn() }));
jest.mock('../../hooks/useNotifications', () => ({ unregisterPushToken: jest.fn() }));

interface Recorded {
  url: string;
  authorization: string | undefined;
}

const requests: Recorded[] = [];
let respond: (config: InternalAxiosRequestConfig) => { status: number; data: unknown };

/**
 * On the unfixed code the loop never ends by itself: it runs until the screen
 * unmounts, and nothing unmounts it here. Past this many requests the network
 * stops answering, so the test can fail on a count instead of on a timeout.
 */
const STORM_LIMIT = 50;

const adapter: AxiosAdapter = async (config) => {
  const authorization = config.headers?.Authorization;
  requests.push({
    url: config.url ?? '',
    authorization: typeof authorization === 'string' ? authorization : undefined,
  });
  if (requests.length > STORM_LIMIT) {
    return new Promise<never>(() => undefined);
  }
  const { status, data } = respond(config);
  const response = { status, statusText: String(status), headers: {}, config, data };
  if (status >= 200 && status < 300) return response;
  throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, response);
};

const USAGE = {
  tier: 'FREE',
  teams: { count: 1, limit: null, limitReached: false },
  seasons: { count: 1, limit: null, limitReached: false },
};

/** What the API answers once the session is gone. */
const unauthorized = (): { status: number; data: unknown } => ({ status: 401, data: { error: 'Unauthorized' } });

/**
 * Stands in for the Profile tab, which stays mounted under a pushed screen.
 * It does the two things Profile does, and both are needed for the loop:
 *
 *   - it holds a session-bound query (`useUsage`);
 *   - it subscribes to the WHOLE auth store (`useAuthStore()` with no
 *     selector, as Profile, Home and seven other screens do), so it re-renders
 *     on every store write. After the cache was cleared, a re-render is what
 *     makes the observer build a new query and fetch it.
 *
 * A probe with a selector (`useAuthUser`) re-renders once and sends one stray
 * request; a probe with no store subscription sends none. Neither shows the
 * storm.
 */
function UsageProbe(): React.JSX.Element {
  const { user } = useAuthStore();
  const { data, isError } = useUsage();
  const state = isError ? 'error' : data ? `teams:${data.teams.count}` : 'loading';
  return <Text>{`${user ? 'in' : 'out'} ${state}`}</Text>;
}

function signIn(tokens: { refreshToken: string | null }): void {
  useAuthStore.setState({
    user: { id: 'me', role: 'COACH', email: 'me@example.com', name: 'Me' } as never,
    isAuthenticated: true,
    accessToken: 'access-1',
    refreshToken: tokens.refreshToken,
    isLoading: false,
  });
}

/** Long enough for a runaway loop to show: on the unfixed code it makes hundreds of requests. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

async function mountSignedIn(): Promise<ReturnType<typeof render>> {
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <UsageProbe />
    </QueryClientProvider>
  );
  await waitFor(() => expect(screen.getByText('in teams:1')).toBeTruthy());
  return screen;
}

describe('ending a session (#582)', () => {
  const originalAdapter = apiClient.defaults.adapter;

  beforeEach(() => {
    requests.length = 0;
    queryClient.clear();
    apiClient.defaults.adapter = adapter;
    respond = (config) =>
      config.url === '/auth/me/usage' ? { status: 200, data: { success: true, usage: USAGE } } : unauthorized();
  });

  afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    queryClient.clear();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      accessToken: null,
      refreshToken: null,
      isLoading: false,
    });
  });

  it('sends nothing after a local sign-out, with a session-bound query still mounted', async () => {
    signIn({ refreshToken: null });
    await mountSignedIn();
    expect(requests).toEqual([{ url: '/auth/me/usage', authorization: 'Bearer access-1' }]);

    respond = unauthorized;
    requests.length = 0;
    act(() => {
      useAuthStore.getState().clearSession();
    });
    await settle();

    // The count first: on the unfixed code this reads 51, the cap.
    expect(requests).toHaveLength(0);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('sends nothing after account deletion', async () => {
    signIn({ refreshToken: null });
    await mountSignedIn();
    respond = (config) =>
      config.method === 'delete' ? { status: 200, data: { success: true } } : unauthorized();
    requests.length = 0;

    await act(async () => {
      await apiClient.delete('/auth/me');
      useAuthStore.getState().clearSession();
    });
    await settle();

    expect(requests).toHaveLength(1);
    expect(requests).toEqual([{ url: '/auth/me', authorization: 'Bearer access-1' }]);
  });

  it('ends the session once when the refresh token is rejected, then goes quiet', async () => {
    signIn({ refreshToken: 'refresh-1' });
    await mountSignedIn();
    const cleanup = jest.spyOn(queryClient, 'clear');

    // The access token has expired and the refresh token is no longer accepted.
    respond = unauthorized;
    requests.length = 0;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await settle();

    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.url)).toEqual(['/auth/me/usage', '/auth/refresh']);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    cleanup.mockRestore();
  });

  it('still lets a signed-out user reach the endpoints that need no session', async () => {
    respond = () => ({ status: 200, data: { success: true } });

    await apiClient.get('/auth/dev-users');
    await apiClient.post('/auth/dev-login', { email: 'x@example.com' });
    await apiClient.get('/auth/login');
    await apiClient.get('/auth/callback');
    await apiClient.post('/auth/refresh', { refreshToken: 'r' });
    await apiClient.get('/invitations/by-token/abc');
    await apiClient.post('/invitations/by-token/abc/accept');

    expect(requests.map((r) => r.url)).toEqual([
      '/auth/dev-users',
      '/auth/dev-login',
      '/auth/login',
      '/auth/callback',
      '/auth/refresh',
      '/invitations/by-token/abc',
      '/invitations/by-token/abc/accept',
    ]);
    expect(requests.every((r) => r.authorization === undefined)).toBe(true);
  });
});
