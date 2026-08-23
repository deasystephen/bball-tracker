/**
 * Logout side effects (audit #17, #18, #19): push-token unregister and
 * session revocation are best-effort and ordered; local cleanup resets the
 * socket singleton and clears the query cache.
 */

import { apiClient } from '../../services/api-client';
import { queryClient } from '../../services/query-client';
import { resetSocket } from '../../services/socket';
import { unregisterPushToken } from '../../hooks/useNotifications';
import { runRemoteLogout, runLocalLogoutCleanup, LOGOUT_REQUEST_TIMEOUT_MS } from '../../services/session-logout';
import { getSessionHooks } from '../../store/session-hooks';

jest.mock('../../services/socket', () => ({ resetSocket: jest.fn() }));
jest.mock('../../hooks/useNotifications', () => ({ unregisterPushToken: jest.fn() }));

const mockedPost = apiClient.post as jest.Mock;
const mockedUnregister = unregisterPushToken as jest.Mock;
const mockedReset = resetSocket as jest.Mock;

describe('runRemoteLogout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUnregister.mockResolvedValue(undefined);
    mockedPost.mockResolvedValue({ data: { success: true, revoked: true } });
  });

  it('unregisters the push token before revoking the session, with a short timeout', async () => {
    const order: string[] = [];
    mockedUnregister.mockImplementation(async () => {
      order.push('push');
    });
    mockedPost.mockImplementation(async () => {
      order.push('logout');
      return { data: { success: true } };
    });

    await runRemoteLogout();

    expect(order).toEqual(['push', 'logout']);
    expect(mockedUnregister).toHaveBeenCalledWith(LOGOUT_REQUEST_TIMEOUT_MS);
    expect(mockedPost).toHaveBeenCalledWith('/auth/logout', undefined, { timeout: LOGOUT_REQUEST_TIMEOUT_MS });
  });

  it('still calls /auth/logout when the push-token delete fails', async () => {
    mockedUnregister.mockRejectedValue(new Error('offline'));
    await expect(runRemoteLogout()).resolves.toBeUndefined();
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('resolves when /auth/logout fails (404 on an older backend, network error)', async () => {
    mockedPost.mockRejectedValue({ response: { status: 404 } });
    await expect(runRemoteLogout()).resolves.toBeUndefined();
  });
});

describe('registration', () => {
  it('registers both hooks with the auth store on load', () => {
    expect(getSessionHooks()).toEqual({ remoteLogout: runRemoteLogout, localCleanup: runLocalLogoutCleanup });
  });
});

describe('runLocalLogoutCleanup', () => {
  it('resets the socket singleton and clears the query cache', () => {
    queryClient.setQueryData(['teams'], [{ id: 't1' }]);
    expect(queryClient.getQueryData(['teams'])).toBeDefined();

    runLocalLogoutCleanup();

    expect(mockedReset).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['teams'])).toBeUndefined();
  });
});
