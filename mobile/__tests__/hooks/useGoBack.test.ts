/**
 * useGoBack: pop the stack, or replace with the fallback when there is
 * nothing to pop (#595).
 */

import { renderHook } from '@testing-library/react-native';
import { useGoBack } from '../../hooks/useGoBack';

const mockRouter = { replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

describe('useGoBack', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouter.canGoBack.mockReturnValue(true);
  });

  it('pops the stack when there is history', () => {
    const { result } = renderHook(() => useGoBack('/(tabs)/teams'));

    result.current();

    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('replaces with the fallback when there is none', () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const { result } = renderHook(() => useGoBack('/(tabs)/teams'));

    result.current();

    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/teams');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('falls back to Home when no fallback is given', () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const { result } = renderHook(() => useGoBack());

    result.current();

    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home');
  });

  it('asks the router at the time of the press, not at render', () => {
    const { result } = renderHook(() => useGoBack('/(tabs)/games'));
    mockRouter.canGoBack.mockReturnValue(false);

    result.current();

    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/games');
  });
});
