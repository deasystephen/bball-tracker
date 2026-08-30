/**
 * useRosterSortPreference — per-user persisted roster sort choice.
 *
 * Storage is best-effort (same swallow-errors pattern as role-onboarding):
 * a missing userId or a failing AsyncStorage must never break the default
 * jersey order or the in-session toggle.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  useRosterSortPreference,
  rosterSortStorageKey,
  DEFAULT_ROSTER_SORT,
} from '../../hooks/useRosterSortPreference';

describe('useRosterSortPreference', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    await AsyncStorage.clear();
  });

  it('defaults to jersey and hydrates a stored preference for the user', async () => {
    await AsyncStorage.setItem(rosterSortStorageKey('u1'), 'name');
    const { result } = renderHook(() => useRosterSortPreference('u1'));

    expect(DEFAULT_ROSTER_SORT).toBe('jersey');
    await waitFor(() => {
      expect(result.current[0]).toBe('name');
    });
  });

  it('ignores a preference stored for a different user', async () => {
    await AsyncStorage.setItem(rosterSortStorageKey('someone-else'), 'name');
    const { result } = renderHook(() => useRosterSortPreference('u1'));

    // Hydration is async; give the effect a tick before asserting it did nothing.
    await act(async () => {});
    expect(result.current[0]).toBe('jersey');
  });

  it('persists the choice under the user-scoped key', async () => {
    const { result } = renderHook(() => useRosterSortPreference('u1'));

    act(() => {
      result.current[1]('name');
    });

    expect(result.current[0]).toBe('name');
    await waitFor(async () => {
      expect(await AsyncStorage.getItem(rosterSortStorageKey('u1'))).toBe('name');
    });
  });

  it('never touches storage without a userId but still toggles in-session', async () => {
    // AsyncStorage's methods are already jest.fn mocks, so spyOn returns the
    // shared mock — clear the call history from earlier tests first.
    const getSpy = jest.spyOn(AsyncStorage, 'getItem').mockClear();
    const setSpy = jest.spyOn(AsyncStorage, 'setItem').mockClear();
    const { result } = renderHook(() => useRosterSortPreference(undefined));

    expect(result.current[0]).toBe('jersey');
    act(() => {
      result.current[1]('name');
    });
    expect(result.current[0]).toBe('name');

    await act(async () => {});
    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('resets to the default when the userId changes and the new user has nothing stored', async () => {
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | undefined }) => useRosterSortPreference(uid),
      { initialProps: { uid: 'u1' as string | undefined } }
    );

    act(() => {
      result.current[1]('name');
    });
    expect(result.current[0]).toBe('name');

    // Account switch: u1's choice must not bleed into u2's view.
    rerender({ uid: 'u2' });
    await act(async () => {});
    expect(result.current[0]).toBe('jersey');
  });

  it('hydrates the new user’s stored choice after a switch', async () => {
    await AsyncStorage.setItem(rosterSortStorageKey('u2'), 'name');
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | undefined }) => useRosterSortPreference(uid),
      { initialProps: { uid: 'u1' as string | undefined } }
    );

    await act(async () => {});
    expect(result.current[0]).toBe('jersey');

    rerender({ uid: 'u2' });
    await waitFor(() => {
      expect(result.current[0]).toBe('name');
    });
  });

  it('keeps a tap made while userId was still undefined once the id arrives', async () => {
    // Cold-start deep link: pills can render before auth-store rehydration
    // resolves. A tap in that window must survive the arriving hydration.
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | undefined }) => useRosterSortPreference(uid),
      { initialProps: { uid: undefined as string | undefined } }
    );

    act(() => {
      result.current[1]('name');
    });
    expect(result.current[0]).toBe('name');

    rerender({ uid: 'u1' });
    await act(async () => {});
    expect(result.current[0]).toBe('name');
  });

  it('keeps the default when the storage read fails', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => useRosterSortPreference('u1'));

    await act(async () => {});
    expect(result.current[0]).toBe('jersey');
  });

  it('keeps the in-session choice when the storage write fails', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => useRosterSortPreference('u1'));

    act(() => {
      result.current[1]('name');
    });

    await act(async () => {});
    expect(result.current[0]).toBe('name');
  });
});
