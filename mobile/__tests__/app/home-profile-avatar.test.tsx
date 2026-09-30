/**
 * Home — the profile button in the greeting bar (#607).
 *
 * It used to draw its own circle with the first letter of the name and never
 * read `profilePictureUrl`, so a user with a photo saw it on Profile only.
 */

import { Image } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

import Home from '../../app/(tabs)/home';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const query = (data: unknown) => ({
  data,
  isLoading: false,
  isRefetching: false,
  refetch: jest.fn(),
});

jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useInfiniteTeams: () => query({ teams: [], total: 0 }),
}));
jest.mock('../../hooks/useGames', () => ({
  useLiveGames: () => query([]),
  useGames: () => query([]),
  useGamesPage: () => query({ games: [], total: 0 }),
}));
jest.mock('../../hooks/useInvitations', () => ({
  useInvitations: () => query({ invitations: [] }),
}));

const signIn = (profilePictureUrl?: string | null) => {
  useAuthStore.setState({
    user: {
      id: 'frank',
      role: 'COACH',
      email: 'frank.vogel@example.com',
      name: 'Frank Vogel',
      profilePictureUrl,
    } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('Home profile button (#607)', () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the user's photo when they have one", () => {
    signIn('https://example.com/avatar.jpg');
    const { getByLabelText } = render(<Home />);

    const button = getByLabelText('Profile');
    const images = button.findAllByType(Image);
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({ uri: 'https://example.com/avatar.jpg' });
  });

  it('falls back to initials without a photo', () => {
    signIn(null);
    const { getByLabelText } = render(<Home />);

    const button = getByLabelText('Profile');
    expect(button.findAllByType(Image)).toHaveLength(0);
    expect(button.findByProps({ children: 'FV' })).toBeTruthy();
  });

  it('opens Profile on tap', () => {
    signIn(null);
    const { getByLabelText } = render(<Home />);

    fireEvent.press(getByLabelText('Profile'));
    expect(mockRouter.push).toHaveBeenCalledWith('/profile');
  });
});
