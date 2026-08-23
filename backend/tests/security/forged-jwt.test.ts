/**
 * End-to-end check that the real `authenticate` middleware, backed by the real
 * `WorkOSService.verifyToken`, rejects forged bearer tokens. Only the JWKS
 * source is mocked — everything else is the production code path.
 *
 * Regression test for the audit finding "JWT signature never verified".
 */

const mockGetWorkOSJwks = jest.fn();
jest.mock('../../src/utils/workos-client', () => ({
  workos: { userManagement: {} },
  WORKOS_CLIENT_ID: 'test-client-id',
  WORKOS_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  WORKOS_JWT_ISSUER: 'https://api.workos.com',
  getWorkOSJwks: (): unknown => mockGetWorkOSJwks(),
}));

import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, errors as joseErrors, type KeyLike } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { mockPrisma } from '../setup';
import { authenticate } from '../../src/api/auth/middleware';

describe('authenticate with forged tokens', () => {
  let privateKey: KeyLike;
  const user = { id: 'u1', email: 'victim@example.com', name: 'Victim', role: 'ADMIN', subscriptionTier: 'FREE', subscriptionExpiresAt: null };

  const run = async (token: string): Promise<{ req: Partial<Request>; next: jest.Mock }> => {
    const req: Partial<Request> = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    await authenticate(req as Request, {} as Response, next as NextFunction);
    return { req, next };
  };

  beforeAll(async () => {
    ({ privateKey } = await generateKeyPair('ES256'));
    const pub = await exportJWK(privateKey);
    delete pub.d;
    mockGetWorkOSJwks.mockReturnValue(createLocalJWKSet({ keys: [{ ...pub, kid: 'k1', alg: 'ES256' }] }));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
  });

  it('accepts a token signed by the JWKS key and attaches the user', async () => {
    const token = await new SignJWT({ sub: 'user_victim' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('https://api.workos.com')
      .setExpirationTime('5m')
      .sign(privateKey);

    const { req, next } = await run(token);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual(user);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workosUserId: 'user_victim' } })
    );
  });

  it('rejects an unsigned token that names a victim user id', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user_victim', iss: 'https://api.workos.com', exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');

    const { req, next } = await run(`${header}.${payload}.sig`);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(req.user).toBeUndefined();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token with a valid header but an attacker-chosen signature', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user_victim', iss: 'https://api.workos.com', exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');

    const { next } = await run(`${header}.${payload}.${'A'.repeat(86)}`);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token with the exp claim stripped', async () => {
    const token = await new SignJWT({ sub: 'user_victim' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('https://api.workos.com')
      .sign(privateKey);

    const { next } = await run(token);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('surfaces a JWKS outage as 503, not 401', async () => {
    mockGetWorkOSJwks.mockReturnValueOnce(async () => {
      throw new joseErrors.JWKSTimeout();
    });
    const token = await new SignJWT({ sub: 'user_victim' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('https://api.workos.com')
      .setExpirationTime('5m')
      .sign(privateKey);

    const { next } = await run(token);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503 }));
  });
});
