/**
 * `services/app-build.ts` (#963): what the running build is, and the two
 * request headers built from it. The `X-Hooplings-Client` shape is the API's
 * contract (`docs/architecture/backend-services.md`): an unparseable value is
 * dropped there, so the app sends nothing rather than something malformed.
 */

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { uuid } from 'expo-modules-core';
import Constants from 'expo-constants';
import { clientHeaderValue, getRunningBuild, newRequestId, type RunningBuild } from '../../services/app-build';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.6.0' } },
}));
const mockConstants = Constants as unknown as { expoConfig: { version?: string } | null };

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  uuid: { v4: jest.fn() },
}));

const mockedRequire = requireOptionalNativeModule as jest.Mock;
const mockedV4 = uuid.v4 as jest.Mock;
const UPDATE_ID = '01a15220-8b6d-7172-a9a5-2d5fce7c6954';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const withUpdates = (constants: Record<string, unknown> | null) =>
  mockedRequire.mockImplementation((name: string) => (name === 'ExpoUpdates' ? constants : null));

const build = (overrides: Partial<RunningBuild> = {}): RunningBuild => ({
  appVersion: '1.6.0',
  launch: 'update',
  updateId: UPDATE_ID,
  runtimeVersion: '1.6.0',
  ...overrides,
});

const setOS = (os: string) => Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });

describe('app-build (#963)', () => {
  const originalImpl = mockedRequire.getMockImplementation();

  beforeEach(() => {
    mockConstants.expoConfig = { version: '1.6.0' };
    setOS('ios');
  });

  afterAll(() => {
    if (originalImpl) mockedRequire.mockImplementation(originalImpl);
  });

  describe('getRunningBuild', () => {
    it('reports a running OTA by its lower-cased id and runtime', () => {
      withUpdates({ isEnabled: true, isEmbeddedLaunch: false, updateId: UPDATE_ID.toUpperCase(), runtimeVersion: '1.6.0' });
      expect(getRunningBuild()).toEqual({ appVersion: '1.6.0', launch: 'update', updateId: UPDATE_ID, runtimeVersion: '1.6.0' });
    });

    it('reports the bundled JS as embedded, with no update id', () => {
      withUpdates({ isEnabled: true, isEmbeddedLaunch: true, updateId: UPDATE_ID, runtimeVersion: '1.6.0' });
      expect(getRunningBuild()).toMatchObject({ launch: 'embedded', updateId: null });
    });

    it('treats a dev client (updates disabled) as embedded, with the app version as runtime', () => {
      withUpdates({ isEnabled: false, isEmbeddedLaunch: false, updateId: UPDATE_ID, runtimeVersion: null });
      expect(getRunningBuild()).toEqual({ appVersion: '1.6.0', launch: 'embedded', updateId: null, runtimeVersion: '1.6.0' });
    });

    it('never throws on a binary without the ExpoUpdates module, or when the probe throws', () => {
      withUpdates(null);
      expect(getRunningBuild()).toEqual({ appVersion: '1.6.0', launch: 'embedded', updateId: null, runtimeVersion: '1.6.0' });
      mockedRequire.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(getRunningBuild().launch).toBe('embedded');
    });

    it('says unknown when expo-constants has no version', () => {
      withUpdates(null);
      mockConstants.expoConfig = null;
      expect(getRunningBuild()).toMatchObject({ appVersion: 'unknown', runtimeVersion: 'unknown' });
    });
  });

  describe('clientHeaderValue', () => {
    it('is <platform>/<version>+<update id> for an OTA', () => {
      expect(clientHeaderValue(build())).toBe(`ios/1.6.0+${UPDATE_ID}`);
      setOS('android');
      expect(clientHeaderValue(build())).toBe(`android/1.6.0+${UPDATE_ID}`);
    });

    it('ends in +embedded when no update is running', () => {
      expect(clientHeaderValue(build({ launch: 'embedded', updateId: null }))).toBe('ios/1.6.0+embedded');
    });

    it('stays within the API contract: at most 64 characters, the documented shape', () => {
      const value = clientHeaderValue(build()) ?? '';
      expect(value.length).toBeLessThanOrEqual(64);
      expect(value).toMatch(/^(ios|android)\/\d+(\.\d+){0,3}(\+[A-Za-z0-9._-]{1,40})?$/);
    });

    it('drops a build suffix the API would not accept, keeping the version', () => {
      expect(clientHeaderValue(build({ updateId: 'not a uuid!' }))).toBe('ios/1.6.0');
    });

    it('is null on another platform or a version the API would not parse', () => {
      setOS('web');
      expect(clientHeaderValue(build())).toBeNull();
      setOS('ios');
      expect(clientHeaderValue(build({ appVersion: 'unknown' }))).toBeNull();
      expect(clientHeaderValue(build({ appVersion: '1.2.3.4.5' }))).toBeNull();
    });

    it('reads the running build when not given one, once per process', () => {
      withUpdates({ isEnabled: true, isEmbeddedLaunch: false, updateId: UPDATE_ID, runtimeVersion: '1.6.0' });
      expect(clientHeaderValue()).toBe(`ios/1.6.0+${UPDATE_ID}`);
      // An OTA applies only on the next launch, so the value never changes in a process.
      withUpdates(null);
      expect(clientHeaderValue()).toBe(`ios/1.6.0+${UPDATE_ID}`);
    });
  });

  describe('newRequestId', () => {
    it("uses expo-modules-core's native UUID v4, lower-cased", () => {
      mockedV4.mockReturnValueOnce('4F1C2A3B-5D6E-4F70-8A9B-0C1D2E3F4A5B');
      expect(newRequestId()).toBe('4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b');
    });

    it('falls back to a random v4 when the native generator is missing or returns junk', () => {
      mockedV4.mockImplementationOnce(() => {
        throw new Error("Native UUID version 4 generator implementation wasn't found");
      });
      expect(newRequestId()).toMatch(UUID_V4);
      mockedV4.mockReturnValueOnce('nope');
      expect(newRequestId()).toMatch(UUID_V4);
    });

    it('does not repeat itself on the fallback', () => {
      mockedV4.mockImplementation(() => {
        throw new Error('missing');
      });
      const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
      expect(ids.size).toBe(200);
    });
  });
});
