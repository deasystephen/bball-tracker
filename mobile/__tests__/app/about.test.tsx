/**
 * About screen — version/OTA diagnostics (Profile → About).
 *
 * The screen must show the applied update's id + publish time when an OTA is
 * running, fall back to "Embedded build" when the binary's bundled JS is
 * running (or expo-updates is disabled, i.e. a dev client), and export the
 * same fields through the Share sheet.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import AboutScreen, { formatAboutDiagnostics, getAboutInfo } from '../../app/about';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };

// Mutable stand-in for expo-updates module state (read at render time).
const mockUpdates: {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId: string | null;
  createdAt: Date | null;
  channel: string | null;
  runtimeVersion: string | null;
} = {
  isEnabled: true,
  isEmbeddedLaunch: false,
  updateId: null,
  createdAt: null,
  channel: null,
  runtimeVersion: null,
};

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
// The factory runs while the test file's imports are still being resolved
// (before `mockUpdates` is initialized), so it must not touch the object —
// lazy getters read it at render time instead. `__esModule` makes Babel's
// `import * as` interop return this object as-is (a plain object would be
// copied, hiding per-test mutations).
jest.mock('expo-updates', () => ({
  __esModule: true,
  get isEnabled() { return mockUpdates.isEnabled; },
  get isEmbeddedLaunch() { return mockUpdates.isEmbeddedLaunch; },
  get updateId() { return mockUpdates.updateId; },
  get createdAt() { return mockUpdates.createdAt; },
  get channel() { return mockUpdates.channel; },
  get runtimeVersion() { return mockUpdates.runtimeVersion; },
}));
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.2.0' } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const OTA_ID = '01a04a73-9a22-726b-b5e7-4cde90de4ddf';

function setOtaApplied() {
  mockUpdates.isEnabled = true;
  mockUpdates.isEmbeddedLaunch = false;
  mockUpdates.updateId = OTA_ID;
  mockUpdates.createdAt = new Date('2026-08-28T22:18:05.218Z');
  mockUpdates.channel = 'production';
  mockUpdates.runtimeVersion = '1.2.0';
}

function setEmbedded() {
  mockUpdates.isEnabled = true;
  mockUpdates.isEmbeddedLaunch = true;
  mockUpdates.updateId = null;
  mockUpdates.createdAt = null;
  mockUpdates.channel = 'production';
  mockUpdates.runtimeVersion = '1.2.0';
}

describe('AboutScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setOtaApplied();
  });

  it('shows app version, runtime, applied update id and channel', () => {
    const { getByText, getByTestId } = render(<AboutScreen />);
    expect(getByText('v1.2.0')).toBeTruthy();
    expect(getByTestId('about-runtime-version').props.children).toBe('1.2.0');
    expect(getByTestId('about-update').props.children).toContain(OTA_ID);
    expect(getByTestId('about-channel').props.children).toBe('production');
  });

  it('shows "Embedded build" when no OTA has applied', () => {
    setEmbedded();
    const { getByTestId } = render(<AboutScreen />);
    expect(getByTestId('about-update').props.children).toBe('Embedded build (no OTA applied)');
  });

  it('treats a dev client (updates disabled) as embedded with no channel', () => {
    mockUpdates.isEnabled = false;
    mockUpdates.updateId = null;
    mockUpdates.channel = null;
    const { getByTestId } = render(<AboutScreen />);
    expect(getByTestId('about-update').props.children).toBe('Embedded build (no OTA applied)');
    expect(getByTestId('about-channel').props.children).toBe('none (development)');
  });

  it('shares the diagnostics text', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction });
    const { getByText } = render(<AboutScreen />);
    fireEvent.press(getByText('Share diagnostics'));

    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const message = shareSpy.mock.calls[0][0].message as string;
    expect(message).toContain('v1.2.0');
    expect(message).toContain(OTA_ID);
    expect(message).toContain('2026-08-28T22:18:05.218Z');
    expect(message).toContain('Channel: production');
  });

  it('navigates back from the header', () => {
    const { getByLabelText } = render(<AboutScreen />);
    fireEvent.press(getByLabelText('Go back'));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  describe('getAboutInfo / formatAboutDiagnostics', () => {
    it('null updateId counts as embedded even when isEmbeddedLaunch is false', () => {
      mockUpdates.isEmbeddedLaunch = false;
      mockUpdates.updateId = null;
      const info = getAboutInfo();
      expect(info.isEmbedded).toBe(true);
      expect(formatAboutDiagnostics(info)).toContain('embedded build (no OTA applied)');
    });

    it('falls back to the app version when runtimeVersion is missing', () => {
      mockUpdates.runtimeVersion = null;
      expect(getAboutInfo().runtimeVersion).toBe('1.2.0');
    });
  });
});
