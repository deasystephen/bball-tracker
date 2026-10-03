/**
 * `useScreenViewTracking` (#616): one `screen_viewed` per navigation, carrying
 * the route pattern from `useSegments()` and never the path.
 */
import { renderHook } from '@testing-library/react-native';
import { trackEvent } from '../../services/analytics';
import { useScreenViewTracking } from '../../hooks/useScreenViews';

const mockRouter = { pathname: '/', segments: [] as string[] };

jest.mock('expo-router', () => ({
  usePathname: () => mockRouter.pathname,
  useSegments: () => mockRouter.segments,
}));

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));

const mockedTrack = trackEvent as jest.Mock;

describe('useScreenViewTracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouter.pathname = '/';
    mockRouter.segments = [];
  });

  it('sends the route pattern, not the path, on mount and on every navigation', () => {
    mockRouter.pathname = '/teams/4f1c2e3a-0000-4000-8000-000000000001';
    mockRouter.segments = ['teams', '[id]'];
    const { rerender } = renderHook(() => useScreenViewTracking());

    expect(mockedTrack).toHaveBeenCalledTimes(1);
    expect(mockedTrack).toHaveBeenCalledWith('screen_viewed', { screen: '/teams/[id]', params_kind: 'id' });
    expect(JSON.stringify(mockedTrack.mock.calls)).not.toContain('4f1c2e3a');

    mockRouter.pathname = '/teams/4f1c2e3a-0000-4000-8000-000000000002';
    rerender(undefined);
    // Same pattern, different team: a new view.
    expect(mockedTrack).toHaveBeenCalledTimes(2);

    mockRouter.pathname = '/(tabs)/home';
    mockRouter.segments = ['(tabs)', 'home'];
    rerender(undefined);
    expect(mockedTrack).toHaveBeenLastCalledWith('screen_viewed', { screen: '/(tabs)/home', params_kind: 'none' });
  });

  it('does not repeat a view when the component re-renders on the same path', () => {
    mockRouter.pathname = '/(tabs)/games';
    mockRouter.segments = ['(tabs)', 'games'];
    const { rerender } = renderHook(() => useScreenViewTracking());
    rerender(undefined);
    rerender(undefined);
    expect(mockedTrack).toHaveBeenCalledTimes(1);
  });

  it('never sends an invite token', () => {
    mockRouter.pathname = '/invite/supersecrettoken1234567890';
    mockRouter.segments = ['invite', '[token]'];
    renderHook(() => useScreenViewTracking());
    expect(mockedTrack).toHaveBeenCalledWith('screen_viewed', { screen: '/invite/[token]', params_kind: 'token' });
    expect(JSON.stringify(mockedTrack.mock.calls)).not.toContain('supersecret');
  });
});
