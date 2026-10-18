/**
 * Invite deep link: a network failure, 429 or 5xx on the by-token lookup shows a retryable
 * error, not "Invitation Not Found"; only a 400/404 means the link is dead (#892, the
 * mobile twin of the web page's #720).
 */

import { render, fireEvent } from '@testing-library/react-native';

import InviteDeepLinkScreen from '../../app/invite/[token]';

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
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  useAcceptInvitation: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const httpError = (status: number) => Object.assign(new Error(`status ${status}`), { response: { status } });
const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

function failed(error: unknown, overrides = {}) {
  mockQuery = { data: undefined, isLoading: false, isFetching: false, error, refetch: jest.fn(), ...overrides };
}

describe('InviteDeepLinkScreen load failures (#892)', () => {
  it.each([404, 400])('keeps "Invitation Not Found" for a %i', (status) => {
    failed(httpError(status));
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Invitation Not Found')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });

  it.each([
    ['a 500', httpError(500)],
    ['a 503', httpError(503)],
    ['a 429', httpError(429)],
    ['a network failure', networkError()],
  ])('shows a retryable error for %s', (_label, error) => {
    failed(error);
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.getByText(/couldn't load this invitation/)).toBeTruthy();
    expect(view.queryByText('Invitation Not Found')).toBeNull();

    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockQuery.refetch).toHaveBeenCalledTimes(1);
    expect(view.getByLabelText('Go back')).toBeTruthy();
  });

  it('shows the spinner, not the same error, while Try Again is in flight', () => {
    failed(httpError(500), { isFetching: true });
    const view = render(<InviteDeepLinkScreen />);

    expect(view.getByText('Loading invitation…')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });
});
