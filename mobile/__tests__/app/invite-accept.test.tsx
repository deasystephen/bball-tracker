/**
 * Deep-link invitation screen (`/invite/<token>`): the inviter (and, on a
 * guardian invitation, the child) render through `utils/display-name`, so a
 * deleted account shows the localized label from `inviterDeletedAt` /
 * `childDeletedAt`, never the stored English literal (#674, #642, #813). The
 * screen accepts with `source: 'link'` for analytics (#822 review).
 */

import { render } from '@testing-library/react-native';

import InviteDeepLinkScreen from '../../app/invite/[token]';
import { i18n } from '../../i18n';
import type { InvitationByToken } from '../../hooks/useInvitationByToken';

let mockInvitation: InvitationByToken | undefined;
const mockUseAcceptInvitation = jest.fn((_options?: { source?: string }) => ({ mutateAsync: jest.fn(), isPending: false }));

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
  useAcceptInvitation: (options?: { source?: string }) => mockUseAcceptInvitation(options),
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

describe('InviteDeepLinkScreen guardian invitation (#813)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  const guardianInvitation = (overrides: Record<string, unknown> = {}): InvitationByToken => ({
    kind: 'guardian',
    id: 'gi-1',
    status: 'PENDING',
    childName: 'Steph Curry',
    childDeletedAt: null,
    teamName: 'Warriors',
    inviterName: 'Steve Kerr',
    inviterDeletedAt: null,
    relationship: 'FATHER',
    expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    ...overrides,
  } as InvitationByToken);

  it('names a live child and inviter', () => {
    mockInvitation = guardianInvitation();
    const { getByText, getAllByText } = render(<InviteDeepLinkScreen />);

    expect(getAllByText('Steph Curry').length).toBeGreaterThan(0);
    expect(getByText('Steve Kerr')).toBeTruthy();
  });

  it('shows a deleted child and inviter with the localized label', async () => {
    mockInvitation = guardianInvitation({
      childName: 'Deleted user',
      childDeletedAt: '2026-09-01T00:00:00.000Z',
      inviterName: 'Deleted user',
      inviterDeletedAt: '2026-09-01T00:00:00.000Z',
    });
    await i18n.changeLanguage('es');
    const { getAllByText, queryByText } = render(<InviteDeepLinkScreen />);

    // Child row and inviter row.
    expect(getAllByText('Usuario eliminado')).toHaveLength(2);
    expect(queryByText(/Deleted user/)).toBeNull();
  });
});

describe('InviteDeepLinkScreen analytics source', () => {
  it('accepts with source: link', () => {
    mockUseAcceptInvitation.mockClear();
    mockInvitation = teamInvitation();
    render(<InviteDeepLinkScreen />);

    expect(mockUseAcceptInvitation).toHaveBeenCalledWith({ source: 'link' });
  });
});
