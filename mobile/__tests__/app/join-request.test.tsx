/**
 * Deep-link join screen (`/join/<token>`, #210): a team join link only lets a
 * signed-in adult ASK to join, as themself or for their child. Rendered with
 * the real i18n instance.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AxiosError } from 'axios';

import JoinDeepLinkScreen from '../../app/join/[token]';
import { i18n } from '../../i18n';
import { useAuthStore } from '../../store/auth-store';
import { RETURN_PATH_KEY } from '../../utils/return-path';
import type { JoinLinkPreview } from '../../hooks/useJoinLink';

let mockPreview: JoinLinkPreview | undefined;
let mockError: unknown = null;
const mockRefetch = jest.fn();
const mockShowToast = jest.fn();
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockRequestToJoin = { mutateAsync: jest.fn(), isPending: false };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ token: 'tok-join-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
// jest.setup mocks the whole api-client; keep the real classification and message helpers.
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../hooks/useJoinLink', () => ({
  ...jest.requireActual('../../hooks/useJoinLink'),
  useJoinLinkPreview: () => ({ data: mockPreview, isLoading: false, error: mockError, refetch: mockRefetch }),
  useRequestToJoin: () => mockRequestToJoin,
}));

function signedIn(isAuthenticated: boolean): void {
  useAuthStore.setState({
    user: isAuthenticated ? ({ id: 'u1', role: 'PLAYER', email: 'a@b.c', name: 'A' } as never) : null,
    isAuthenticated,
    accessToken: isAuthenticated ? 't' : null,
    refreshToken: null,
    isLoading: false,
  });
}

describe('JoinDeepLinkScreen (#210)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockPreview = { teamName: 'Hornets', state: 'active' };
    mockError = null;
    await AsyncStorage.clear();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('signed out: names the team, explains that a coach approves, and remembers the link through sign-in', async () => {
    signedIn(false);
    const { getByText, queryByText } = render(<JoinDeepLinkScreen />);

    expect(getByText('Join Hornets')).toBeTruthy();
    expect(getByText('Ask to join this team. A coach approves each request before anyone is added.')).toBeTruthy();
    expect(
      getByText('Sign in, or create an account, to ask to join. Parents and guardians sign in for their children.')
    ).toBeTruthy();
    // No form before there is an identity.
    expect(queryByText('Who is joining?')).toBeNull();

    fireEvent.press(getByText('Log In to Continue'));

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/login'));
    const stored = JSON.parse((await AsyncStorage.getItem(RETURN_PATH_KEY)) ?? '{}') as { path?: string };
    expect(stored.path).toBe('/join/tok-join-1');
    expect(mockRequestToJoin.mutateAsync).not.toHaveBeenCalled();
  });

  it('signed in: nothing is preselected and the request cannot be sent until someone is chosen', () => {
    signedIn(true);
    const { getByTestId, getByLabelText } = render(<JoinDeepLinkScreen />);

    expect(getByLabelText('Who is joining? Me').props.accessibilityState).toMatchObject({ selected: false });
    expect(getByLabelText('Who is joining? My child').props.accessibilityState).toMatchObject({ selected: false });
    fireEvent.press(getByTestId('join-submit'));
    expect(mockRequestToJoin.mutateAsync).not.toHaveBeenCalled();
  });

  it('joining as yourself sends { kind: self } and shows that a coach will review it', async () => {
    signedIn(true);
    mockRequestToJoin.mutateAsync.mockResolvedValueOnce({ status: 'pending', created: true, teamName: 'Hornets' });
    const { getByTestId, getByLabelText, findByText, queryByText } = render(<JoinDeepLinkScreen />);

    fireEvent.press(getByLabelText('Who is joining? Me'));
    fireEvent.press(getByTestId('join-submit'));

    expect(await findByText('Request sent')).toBeTruthy();
    expect(
      await findByText("A coach of Hornets will review your request. You'll see the team in the app once it's approved.")
    ).toBeTruthy();
    expect(mockRequestToJoin.mutateAsync).toHaveBeenCalledWith({ token: 'tok-join-1', data: { kind: 'self' } });
    // Only a parent is offered a second request.
    expect(queryByText('Add another child')).toBeNull();
  });

  it('adding a child needs a name, sends it trimmed with the relationship, and offers another child', async () => {
    signedIn(true);
    mockRequestToJoin.mutateAsync.mockResolvedValue({ status: 'pending', created: true, teamName: 'Hornets' });
    const { getByTestId, getByLabelText, getByText, findByText } = render(<JoinDeepLinkScreen />);

    fireEvent.press(getByLabelText('Who is joining? My child'));
    expect(
      getByText("Your child gets a spot on the roster that you manage. Children don't get their own login.")
    ).toBeTruthy();

    // No name yet: nothing is sent.
    fireEvent.press(getByTestId('join-submit'));
    expect(mockRequestToJoin.mutateAsync).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId('join-child-name'), '  Riley Park ');
    fireEvent.press(getByLabelText('Father'));
    fireEvent.press(getByTestId('join-submit'));

    expect(await findByText('Request sent')).toBeTruthy();
    expect(mockRequestToJoin.mutateAsync).toHaveBeenCalledWith({
      token: 'tok-join-1',
      data: { kind: 'child', childName: 'Riley Park', relationship: 'FATHER' },
    });

    // A sibling: back to the form with the name cleared.
    fireEvent.press(getByText('Add another child'));
    expect(getByTestId('join-child-name').props.value).toBe('');
  });

  it('a request that already existed says it is still waiting', async () => {
    signedIn(true);
    mockRequestToJoin.mutateAsync.mockResolvedValueOnce({ status: 'pending', created: false, teamName: 'Hornets' });
    const { getByTestId, getByLabelText, findByText } = render(<JoinDeepLinkScreen />);

    fireEvent.press(getByLabelText('Who is joining? Me'));
    fireEvent.press(getByTestId('join-submit'));

    expect(
      await findByText('Your request to join Hornets is already waiting for a coach to review it.')
    ).toBeTruthy();
  });

  it('someone already on the team goes straight to it', async () => {
    signedIn(true);
    mockRequestToJoin.mutateAsync.mockResolvedValueOnce({ status: 'already_member', teamId: 't9', teamName: 'Hornets' });
    const { getByTestId, getByLabelText } = render(<JoinDeepLinkScreen />);

    fireEvent.press(getByLabelText('Who is joining? Me'));
    fireEvent.press(getByTestId('join-submit'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teams/t9'));
    expect(mockShowToast).toHaveBeenCalledWith("You're already on Hornets", 'success');
  });

  it('a parent whose child is already on the roster is told about the child, not themself', async () => {
    signedIn(true);
    mockRequestToJoin.mutateAsync.mockResolvedValueOnce({ status: 'already_member', teamId: 't9', teamName: 'Hornets' });
    const { getByTestId, getByLabelText } = render(<JoinDeepLinkScreen />);

    fireEvent.press(getByLabelText('Who is joining? My child'));
    fireEvent.changeText(getByTestId('join-child-name'), 'Riley Park');
    fireEvent.press(getByTestId('join-submit'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Riley Park is already on Hornets', 'success'));
  });

  it('a network failure after the preview loaded keeps the form and what was typed (never "not found")', () => {
    signedIn(true);
    // TanStack keeps the data and sets the error when a refetch fails.
    mockError = new AxiosError('Network Error', 'ERR_NETWORK');
    const { getByTestId, getByText, queryByText } = render(<JoinDeepLinkScreen />);

    expect(getByText('Join Hornets')).toBeTruthy();
    expect(getByTestId('join-submit')).toBeTruthy();
    expect(queryByText('Join link not found')).toBeNull();
  });

  it('a refused request shows the error and re-reads the link', async () => {
    signedIn(true);
    mockRequestToJoin.mutateAsync.mockRejectedValueOnce(new Error('boom'));
    const { getByTestId, getByLabelText } = render(<JoinDeepLinkScreen />);

    fireEvent.press(getByLabelText('Who is joining? Me'));
    fireEvent.press(getByTestId('join-submit'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error'));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it.each([
    ['expired', 'Join link expired'],
    ['full', 'Join link is full'],
  ] as const)('a link that is %s offers no form and says to ask the coach', (state, title) => {
    signedIn(true);
    mockPreview = { teamName: 'Hornets', state };
    const { getByText, queryByTestId } = render(<JoinDeepLinkScreen />);

    expect(getByText(title)).toBeTruthy();
    expect(getByText('This link to join Hornets no longer takes requests. Ask the coach for a new one.')).toBeTruthy();
    expect(queryByTestId('join-submit')).toBeNull();
  });

  it('an unknown or replaced link is the not-found screen', () => {
    signedIn(true);
    mockPreview = undefined;
    mockError = new AxiosError('Join link not found', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 404,
      data: { error: 'Join link not found' },
    } as never);
    const { getByText } = render(<JoinDeepLinkScreen />);

    expect(getByText('Join link not found')).toBeTruthy();
    expect(
      getByText("This link is not valid, or the coach replaced it. Ask the coach for the team's current link.")
    ).toBeTruthy();
  });

  it('a network failure, 429 or 5xx is a retry screen, never the dead-link screen', () => {
    signedIn(true);
    mockPreview = undefined;
    mockError = new AxiosError('status 503', 'ERR_BAD_RESPONSE', undefined, undefined, { status: 503 } as never);
    const { getByText, queryByText } = render(<JoinDeepLinkScreen />);

    expect(getByText("We couldn't load this join link. Check your connection and try again.")).toBeTruthy();
    expect(queryByText('Join link not found')).toBeNull();
  });

  it('renders in Spanish', async () => {
    signedIn(true);
    await i18n.changeLanguage('es');
    const { getByText, getByLabelText } = render(<JoinDeepLinkScreen />);

    expect(getByText('Únete a Hornets')).toBeTruthy();
    expect(getByText('¿Quién se une?')).toBeTruthy();
    expect(getByLabelText('¿Quién se une? Mi hijo o hija')).toBeTruthy();
    expect(getByText('Pedir unirme')).toBeTruthy();
  });
});
