/**
 * Invite deep link: a network failure, 429 or 5xx on the by-token lookup shows a retryable
 * error, not "Invitation Not Found"; only a 400/404 means the link is dead (#892, the
 * mobile twin of the web page's #720).
 */

import { render, fireEvent } from '@testing-library/react-native';
import { AxiosError } from 'axios';

import InviteDeepLinkScreen from '../../app/invite/[token]';
import { trackEvent, AnalyticsEvents } from '../../services/analytics';

let mockQuery: {
  data?: unknown;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: jest.Mock;
};

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ token: 'tok-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../hooks/useInvitationByToken', () => ({
  ...jest.requireActual('../../hooks/useInvitationByToken'),
  useInvitationByToken: () => mockQuery,
}));
jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));
// jest.setup mocks the whole api-client; keep the real classification and message helpers.
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  useAcceptInvitation: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const httpError = (status: number) =>
  new AxiosError(`status ${status}`, 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    data: {},
    statusText: '',
    headers: {},
    config: {} as never,
  });
const networkError = () => new AxiosError('Network Error', 'ERR_NETWORK');

function failed(error: unknown, overrides = {}) {
  mockQuery = { data: undefined, isLoading: false, isFetching: false, error, refetch: jest.fn(), ...overrides };
}

describe('InviteDeepLinkScreen load failures (#892)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([404, 400])('keeps "Invitation Not Found" for a %i', (status) => {
    failed(httpError(status));
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Invitation Not Found')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });

  it.each([
    ['a 500', httpError(500)],
    ['a 503', httpError(503)],
    ['a network failure', networkError()],
  ])('shows a retryable error for %s', (_label, error) => {
    failed(error);
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.getByText(/couldn't load this invitation/)).toBeTruthy();
    expect(view.queryByText('Invitation Not Found')).toBeNull();
    expect(view.getByLabelText('Go back')).toBeTruthy();

    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('gives a 429 its own copy', () => {
    failed(httpError(429));
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Too many requests. Wait a few minutes and try again.')).toBeTruthy();
    expect(view.queryByText(/couldn't load this invitation/)).toBeNull();
  });

  it('sends error_shown for the retryable state, once', () => {
    failed(httpError(503));
    const view = render(<InviteDeepLinkScreen />);
    view.rerender(<InviteDeepLinkScreen />);

    const calls = (trackEvent as jest.Mock).mock.calls.filter(([e]) => e === AnalyticsEvents.ERROR_SHOWN);
    expect(calls).toHaveLength(1);
  });

  it('does not treat a local error or a missing session as retryable', () => {
    failed(new TypeError('x is undefined'));
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Invitation Not Found')).toBeTruthy();
  });

  it('shows the spinner, not the same error, while Try Again is in flight', () => {
    failed(httpError(500));
    mockQuery.refetch.mockReturnValue(new Promise(() => {}));
    const view = render(<InviteDeepLinkScreen />);
    fireEvent.press(view.getByLabelText('Try Again'));

    expect(view.getByText('Loading invitation…')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });

  it('keeps the error on screen when a refetch starts without Try Again', () => {
    failed(httpError(500), { isFetching: true });
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
  });
});
