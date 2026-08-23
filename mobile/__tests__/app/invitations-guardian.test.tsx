/**
 * Invitations tab — guardian (PARENT role) cards.
 *
 * Pending GuardianInvitations addressed to the signed-in adult render with
 * "Become <relationship> of <child> on <team>" and "Accept for <child>";
 * accepting refetches GET /auth/me so "My kids" appears immediately. A team
 * invitation addressed to one of the caller's children shows "Accept for".
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';

import InvitationsScreen from '../../app/(tabs)/invitations';
import { useAuthStore } from '../../store/auth-store';
import { apiClient } from '../../services/api-client';
import type { InvitationsResponse, TeamInvitation } from '../../hooks/useInvitations';

const mockShowToast = jest.fn();
const mockAccept = { mutateAsync: jest.fn(), isPending: false };
const mockReject = { mutateAsync: jest.fn(), isPending: false };
let mockData: InvitationsResponse | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  usePlayerInvitations: () => ({
    data: mockData,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    isRefetching: false,
  }),
  useAcceptInvitation: () => mockAccept,
  useRejectInvitation: () => mockReject,
}));

const mockedGet = apiClient.get as jest.Mock;

const guardianInvite = {
  kind: 'guardian' as const,
  id: 'gi1',
  status: 'PENDING' as const,
  childName: 'Steph Curry',
  teamName: 'Warriors',
  inviterName: 'Steve Kerr',
  relationship: 'FATHER' as const,
  expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
};

const teamInviteForChild: TeamInvitation = {
  id: 'ti1',
  teamId: 't2',
  playerId: 'steph',
  invitedById: 'coach-2',
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
  createdAt: '',
  updatedAt: '',
  team: { id: 't2', name: 'Select Team', season: { id: 's', name: '2026', isActive: true, league: { id: 'l', name: 'AAU' } } },
  player: { id: 'steph', name: 'Steph Curry', email: '' },
  invitedBy: { id: 'coach-2', name: 'Coach Two', email: '' },
};

describe('InvitationsScreen guardian invitations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      user: { id: 'dell', role: 'PARENT', email: 'dell.curry@example.com', name: 'Dell Curry' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  it('renders a guardian invitation card with Accept for <child> / Decline', () => {
    mockData = {
      success: true,
      invitations: [],
      guardianInvitations: [guardianInvite],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    };
    const { getByText, queryByText } = render(<InvitationsScreen />);
    expect(getByText('Become father of Steph Curry on Warriors')).toBeTruthy();
    expect(getByText('Invited by Steve Kerr')).toBeTruthy();
    expect(getByText('Accept for Steph Curry')).toBeTruthy();
    expect(getByText('Decline')).toBeTruthy();
    expect(queryByText('No Invitations')).toBeNull();
  });

  it('accepting a guardian invitation refetches /auth/me and merges guardianOf into the store', async () => {
    mockData = {
      success: true,
      invitations: [],
      guardianInvitations: [guardianInvite],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    };
    mockAccept.mutateAsync.mockResolvedValueOnce({ success: true, kind: 'guardian' });
    const guardianOf = [{ childId: 'steph', childName: 'Steph Curry', relationship: 'FATHER', isPrimary: true }];
    mockedGet.mockResolvedValueOnce({ data: { success: true, user: { role: 'PARENT', guardianOf } } });

    const { getByText } = render(<InvitationsScreen />);
    fireEvent.press(getByText('Accept for Steph Curry'));

    await waitFor(() => expect(mockAccept.mutateAsync).toHaveBeenCalledWith('gi1'));
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/auth/me'));
    await waitFor(() => expect(useAuthStore.getState().user?.guardianOf).toEqual(guardianOf));
    expect(mockShowToast).toHaveBeenCalledWith("You are now Steph Curry's father", 'success');
  });

  it('shows "Accept for <child>" on a team invitation addressed to a child', () => {
    mockData = {
      success: true,
      invitations: [teamInviteForChild],
      pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
    };
    const { getByText } = render(<InvitationsScreen />);
    expect(getByText('For Steph Curry')).toBeTruthy();
    expect(getByText('Accept for Steph Curry')).toBeTruthy();
  });

  it('renders the empty state when there are neither team nor guardian invitations', () => {
    mockData = {
      success: true,
      invitations: [],
      guardianInvitations: [],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    };
    const { getByText } = render(<InvitationsScreen />);
    expect(getByText('No Invitations')).toBeTruthy();
  });
});
