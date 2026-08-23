/**
 * useAccessGuard — the shared screen-level permission bounce used by the
 * admin, team-edit, roster and game-tracker screens.
 */

import { renderHook } from '@testing-library/react-native';
import { useAccessGuard } from '../../hooks/useAccessGuard';

const mockRouter = { replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));

describe('useAccessGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouter.canGoBack.mockReturnValue(true);
  });

  it('does nothing while not ready, and returns false', () => {
    const { result } = renderHook(() => useAccessGuard(false, false, 'nope'));
    expect(result.current).toBe(false);
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('returns true and never navigates when allowed', () => {
    const { result } = renderHook(() => useAccessGuard(true, true, 'nope'));
    expect(result.current).toBe(true);
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('toasts and pops the stack once when denied', () => {
    const { result, rerender } = renderHook(() => useAccessGuard(true, false, 'Admins only'));
    expect(result.current).toBe(false);
    expect(mockShowToast).toHaveBeenCalledWith('Admins only', 'error');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    rerender(undefined);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('replaces with the fallback when there is no history', () => {
    mockRouter.canGoBack.mockReturnValue(false);
    renderHook(() => useAccessGuard(true, false, 'nope', { fallback: '/(tabs)/profile' }));
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/profile');
  });

  it('always replaces in replace mode (deep-linkable screens)', () => {
    renderHook(() => useAccessGuard(true, false, 'nope', { fallback: '/games/g1', mode: 'replace' }));
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/games/g1');
  });

  it('bounces once readiness arrives after mount', () => {
    const { result, rerender } = renderHook(
      ({ ready, allowed }: { ready: boolean; allowed: boolean }) =>
        useAccessGuard(ready, allowed, 'nope'),
      { initialProps: { ready: false, allowed: false } }
    );
    expect(mockRouter.back).not.toHaveBeenCalled();
    rerender({ ready: true, allowed: false });
    expect(result.current).toBe(false);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
