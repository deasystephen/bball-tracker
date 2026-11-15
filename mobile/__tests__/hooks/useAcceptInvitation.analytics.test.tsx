/**
 * `useAcceptInvitation` reports where the accept happened: `in_app` by
 * default (Invitations tab), `link` when the deep-link screen passes it.
 */
import { renderHook, act } from '@testing-library/react-native';

import { useAcceptInvitation } from '../../hooks/useInvitations';
import { apiClient } from '../../services/api-client';
import { trackEvent, AnalyticsEvents } from '../../services/analytics';
import { createQueryWrapper } from '../utils/queryWrapper';
import { useAuthStore } from '../../store/auth-store';

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));

const mockedPost = apiClient.post as jest.Mock;
const mockedTrack = trackEvent as jest.Mock;

async function accept(options?: Parameters<typeof useAcceptInvitation>[0], kind?: 'guardian' | 'staff') {
  mockedPost.mockResolvedValueOnce({ data: { success: true, kind, invitation: { id: 'inv-1' } } });
  const { wrapper } = createQueryWrapper();
  const { result } = renderHook(() => useAcceptInvitation(options), { wrapper });
  await act(async () => {
    await result.current.mutateAsync('inv-1');
  });
}

describe('useAcceptInvitation analytics source', () => {
  beforeEach(() => jest.clearAllMocks());

  it('defaults to in_app', async () => {
    await accept();
    expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.INVITATION_ACCEPTED, {
      kind: 'team',
      source: 'in_app',
    });
  });

  it('reports link when the caller passes it', async () => {
    await accept({ source: 'link' }, 'guardian');
    expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.INVITATION_ACCEPTED, {
      kind: 'guardian',
      source: 'link',
    });
  });

  it('a staff accept reports kind staff and takes the role the server now holds (#460)', async () => {
    useAuthStore.setState({ user: { id: 'u1', role: 'PLAYER', email: 'a@b.c', name: 'A' } as never, isAuthenticated: true });
    (apiClient.get as jest.Mock).mockResolvedValueOnce({ data: { success: true, user: { role: 'COACH' } } });

    await accept(undefined, 'staff');

    expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.INVITATION_ACCEPTED, { kind: 'staff', source: 'in_app' });
    expect(apiClient.get).toHaveBeenCalledWith('/auth/me');
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAuthStore.getState().user?.role).toBe('COACH');
  });
});
