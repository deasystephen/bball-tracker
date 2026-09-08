/**
 * Delete account / delete child record screen (#444).
 *
 * The button is armed only by the exact word DELETE; a double tap sends one
 * request; success clears the local session and lands on /login (self) or
 * pops back (child); a 400 last_head_coach renders the blocking teams inline;
 * any other failure toasts and keeps the screen with the button re-enabled.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { AxiosError, AxiosHeaders } from 'axios';
import DeleteAccountScreen, { isConfirmed } from '../../app/account/delete';
import { useAuthStore } from '../../store/auth-store';
import { normalizeApiError } from '../../services/api-client';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: { childId?: string } = {};
const mockShowToast = jest.fn();
const mockDeleteAccount = { mutateAsync: jest.fn(), isPending: false };
const mockDeleteChild = { mutateAsync: jest.fn(), isPending: false };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../hooks/useAccount', () => ({
  ...jest.requireActual('../../hooks/useAccount'),
  useDeleteAccount: () => mockDeleteAccount,
  useDeleteChildRecord: () => mockDeleteChild,
}));

function apiError(status: number, body: Record<string, unknown>): AxiosError {
  const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: 'x',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: body,
  });
  return normalizeApiError(error) as AxiosError;
}

const signIn = (guardianOf: unknown[] = []) =>
  useAuthStore.setState({
    user: { id: 'me', role: 'COACH', email: 'me@example.com', name: 'Me', guardianOf } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });

describe('isConfirmed', () => {
  it('accepts only the exact word DELETE (trimmed, case-sensitive)', () => {
    expect(isConfirmed('DELETE')).toBe(true);
    expect(isConfirmed('  DELETE ')).toBe(true);
    expect(isConfirmed('delete')).toBe(false);
    expect(isConfirmed('Delete')).toBe(false);
    expect(isConfirmed('')).toBe(false);
    expect(isConfirmed('DELETE!')).toBe(false);
  });
});

describe('DeleteAccountScreen (self)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockDeleteAccount.isPending = false;
    signIn();
  });

  it('renders the removed/kept summary and keeps the button disabled until DELETE is typed', () => {
    const { getByText, getByTestId } = render(<DeleteAccountScreen />);
    expect(getByText('Delete your account')).toBeTruthy();
    expect(getByText('What is removed')).toBeTruthy();
    expect(getByText('What is kept (without a name)')).toBeTruthy();

    const button = getByTestId('delete-account-submit');
    expect(button.props.accessibilityState?.disabled).toBe(true);

    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'delete');
    expect(button.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(button);
    expect(mockDeleteAccount.mutateAsync).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'DELETE');
    expect(button.props.accessibilityState?.disabled).toBe(false);
  });

  it('deletes, toasts and lands on /login; the local session is cleared by the hook, never by the screen', async () => {
    mockDeleteAccount.mutateAsync.mockResolvedValue({ success: true, identityDeleted: true });
    const { getByTestId } = render(<DeleteAccountScreen />);

    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'DELETE');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/login'));
    expect(mockDeleteAccount.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Your account has been deleted', 'success');
  });

  it('sends one request on a double tap (button disabled while pending)', async () => {
    let resolveDelete: (v: unknown) => void = () => undefined;
    mockDeleteAccount.mutateAsync.mockImplementation(
      () => new Promise((resolve) => { resolveDelete = resolve; })
    );
    const { getByTestId, rerender } = render(<DeleteAccountScreen />);
    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'DELETE');
    fireEvent.press(getByTestId('delete-account-submit'));
    mockDeleteAccount.isPending = true;
    rerender(<DeleteAccountScreen />);
    expect(getByTestId('delete-account-submit').props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(getByTestId('delete-account-submit'));
    expect(mockDeleteAccount.mutateAsync).toHaveBeenCalledTimes(1);
    resolveDelete({ success: true, identityDeleted: true });
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/login'));
  });

  it('renders the blocking teams inline on 400 last_head_coach and links to each team', async () => {
    mockDeleteAccount.mutateAsync.mockRejectedValue(
      apiError(400, {
        error: 'You are the only Head Coach…',
        code: 'last_head_coach',
        teams: [{ id: 't1', name: 'Lakers' }, { id: 't2', name: 'Bulls' }],
      })
    );
    const { getByTestId, getByText, getByLabelText } = render(<DeleteAccountScreen />);
    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'DELETE');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() => expect(getByTestId('last-head-coach-block')).toBeTruthy());
    expect(getByText('Hand your teams over first')).toBeTruthy();
    expect(getByText('Lakers')).toBeTruthy();
    expect(getByText('Bulls')).toBeTruthy();
    fireEvent.press(getByLabelText('Open team Bulls'));
    expect(mockRouter.push).toHaveBeenCalledWith('/teams/t2');
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('toasts the server message on any other failure and stays on the screen, button re-enabled', async () => {
    mockDeleteAccount.mutateAsync.mockRejectedValue(apiError(500, { error: 'Failed to delete account' }));
    const { getByTestId } = render(<DeleteAccountScreen />);
    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'DELETE');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to delete account', 'error'));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(getByTestId('delete-account-submit').props.accessibilityState?.disabled).toBe(false);
  });

  it('Cancel and the back arrow go back', () => {
    const { getByText, getByLabelText } = render(<DeleteAccountScreen />);
    fireEvent.press(getByText('Cancel'));
    fireEvent.press(getByLabelText('Go back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(2);
  });
});

describe('DeleteAccountScreen (guardian, ?childId=)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { childId: 'bryce' };
    mockDeleteChild.isPending = false;
    signIn([{ childId: 'bryce', childName: 'Bryce James', relationship: 'MOTHER', isPrimary: true, isManaged: true }]);
  });

  it('renders child copy, deletes the record, toasts and pops back', async () => {
    mockDeleteChild.mutateAsync.mockResolvedValue(undefined);
    const { getByText, getByTestId } = render(<DeleteAccountScreen />);
    expect(getByText("Delete Bryce James's record")).toBeTruthy();
    expect(getByText('Delete record')).toBeTruthy();

    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'DELETE');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(mockDeleteChild.mutateAsync).toHaveBeenCalledWith({ childId: 'bryce' });
    expect(mockDeleteAccount.mutateAsync).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith("Bryce James's record has been deleted", 'success');
  });

  it('toasts a 403 (child claimed since) and stays', async () => {
    mockDeleteChild.mutateAsync.mockRejectedValue(
      apiError(403, { error: 'Only the account owner can delete a claimed account' })
    );
    const { getByTestId } = render(<DeleteAccountScreen />);
    fireEvent.changeText(getByTestId('delete-confirmation-input'), 'DELETE');
    fireEvent.press(getByTestId('delete-account-submit'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Only the account owner can delete a claimed account', 'error')
    );
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});
