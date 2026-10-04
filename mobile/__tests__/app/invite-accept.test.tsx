/**
 * Deep-link invitation screen (`/invite/<token>`): the inviter renders through
 * `displayName`, so a deleted inviter shows the localized label from
 * `inviterDeletedAt`, never the stored English literal (#674, #642).
 */

import { render } from '@testing-library/react-native';

import InviteDeepLinkScreen from '../../app/invite/[token]';
import { i18n } from '../../i18n';
import type { InvitationByToken } from '../../hooks/useInvitationByToken';

let mockInvitation: InvitationByToken | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ token: 'tok-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../hooks/useInvitationByToken', () => ({
  ...jest.requireActual('../../hooks/useInvitationByToken'),
  useInvitationByToken: () => ({ data: mockInvitation, isLoading: false, error: null }),
}));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  useAcceptInvitation: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const teamInvitation = (overrides: Partial<InvitationByToken> = {}): InvitationByToken => ({
  kind: 'team',
  id: 'inv-1',
  status: 'PENDING',
  teamName: 'Lakers',
  inviterName: 'Frank Vogel',
  inviterDeletedAt: null,
  position: null,
  jerseyNumber: null,
  message: null,
  expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
  ...overrides,
} as InvitationByToken);

describe('InviteDeepLinkScreen inviter name', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows a live inviter by name', () => {
    mockInvitation = teamInvitation();
    const { getByText } = render(<InviteDeepLinkScreen />);

    expect(getByText('Frank Vogel')).toBeTruthy();
  });

  it('shows a deleted inviter with the localized label, never the stored literal', async () => {
    mockInvitation = teamInvitation({ inviterName: 'Deleted user', inviterDeletedAt: '2026-09-01T00:00:00.000Z' });
    await i18n.changeLanguage('es');
    const { getByText, queryByText } = render(<InviteDeepLinkScreen />);

    expect(getByText('Usuario eliminado')).toBeTruthy();
    expect(queryByText('Deleted user')).toBeNull();
  });

  it('falls back to the stored name when the payload omits inviterDeletedAt (older API)', () => {
    const older: Record<string, unknown> = { ...teamInvitation() };
    delete older.inviterDeletedAt;
    mockInvitation = older as unknown as InvitationByToken;
    const { getByText } = render(<InviteDeepLinkScreen />);

    expect(getByText('Frank Vogel')).toBeTruthy();
  });
});
