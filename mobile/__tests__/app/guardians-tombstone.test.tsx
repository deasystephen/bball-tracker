/**
 * Guardians list rows (#813): a guardian whose account was deleted renders
 * the localized label from `deletedAt`, never the stored English literal.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import PlayerGuardiansScreen from '../../app/teams/[id]/players/[playerId]/guardians';
import { useAuthStore } from '../../store/auth-store';
import { i18n } from '../../i18n';
import type { GuardianRow } from '../../hooks/useGuardians';

let mockGuardians: GuardianRow[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 't1', playerId: 'steph' }),
}));
jest.mock('../../hooks/useGoBack', () => ({ useGoBack: () => jest.fn() }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({
    data: {
      id: 't1',
      name: 'Warriors',
      staff: [{ userId: 'coach-1', role: { canManageRoster: true } }],
      members: [{ playerId: 'steph', player: { id: 'steph', name: 'Steph Curry', isManaged: false, deletedAt: null } }],
    },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
}));
jest.mock('../../hooks/useGuardians', () => ({
  ...jest.requireActual('../../hooks/useGuardians'),
  usePlayerGuardians: () => ({
    data: { guardians: mockGuardians, pendingInvitations: [] },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useInviteGuardian: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRemoveGuardian: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

describe('PlayerGuardiansScreen guardian names', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'coach-1', role: 'COACH', email: 'coach@example.test', name: 'Coach' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('names a deleted guardian with the localized label from deletedAt', async () => {
    mockGuardians = [
      {
        id: 'g1',
        userId: 'gone',
        name: 'Deleted user',
        deletedAt: '2026-09-01T00:00:00.000Z',
        email: null,
        relationship: 'MOTHER',
        isPrimary: true,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ];
    await i18n.changeLanguage('es');
    const { getByText, getByLabelText, queryByText } = render(<PlayerGuardiansScreen />);

    expect(getByText('Usuario eliminado')).toBeTruthy();
    expect(getByLabelText(/^Usuario eliminado, /)).toBeTruthy();
    expect(queryByText(/Deleted user/)).toBeNull();
  });

  it('names a live guardian by name', () => {
    mockGuardians = [
      { id: 'g2', userId: 'sonya', name: 'Sonya Curry', deletedAt: null, relationship: 'MOTHER', isPrimary: true, createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    const { getByText } = render(<PlayerGuardiansScreen />);
    expect(getByText('Sonya Curry')).toBeTruthy();
  });
});
