/**
 * Shared mock of `src/utils/workos-client` for suites that stub WorkOS.
 *
 * Use from a `jest.mock` factory, and import `mockWorkOSClient` to configure
 * the SDK calls:
 *
 *   jest.mock('../../src/utils/workos-client', () =>
 *     jest.requireActual('../support/workos-mock').mockWorkOSClientModule({ ... }));
 */

export const mockWorkOSClient = {
  userManagement: {
    getAuthorizationUrl: jest.fn().mockResolvedValue('https://auth.workos.com/authorize'),
    authenticateWithCode: jest.fn(),
    authenticateWithRefreshToken: jest.fn(),
    revokeSession: jest.fn(),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    getUser: jest.fn(),
    listUsers: jest.fn(),
  },
};

export function mockWorkOSClientModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getWorkOS: (): unknown => mockWorkOSClient,
    getWorkOSClientId: (): string => 'test-client-id',
    assertWorkOSConfig: (): void => undefined,
    WORKOS_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    WORKOS_JWT_ISSUER: 'https://api.workos.com',
    // Empty key set: any JWT-shaped token fails with JWKSNoMatchingKey (401),
    // garbage fails with JWSInvalid (401).
    getWorkOSJwks: (): unknown => jest.requireActual('jose').createLocalJWKSet({ keys: [] }),
    ...overrides,
  };
}
