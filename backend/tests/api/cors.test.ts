/**
 * CORS contract for the public web invite flow (#447).
 *
 * The web invite page at hooplings.com POSTs the accept cross-origin to the API
 * (web/app/invite/[token]/invite-client.tsx), which is a preflighted request. The
 * allowlist lives ONLY in infra/task-definition.json (CORS_ORIGIN), so this suite
 * reads that value out of the deploy file and boots the app with it: dropping the
 * apex from the deploy file fails here before it can reach ECS.
 *
 *   infra/task-definition.json ──CORS_ORIGIN──▶ process.env ──▶ src/index.ts
 *        (what CI deploys)                                        cors({ origin: [...] })
 *                                                                      │
 *   OPTIONS + Origin: apex ─────────────────────────────────────▶ 204 + ACAO: apex
 *   OPTIONS + Origin: evil ─────────────────────────────────────▶ 204, no ACAO
 *   POST    + no Origin (mobile) ───────────────────────────────▶ route reached, no ACAO
 */

import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import type { Express } from 'express';
import type { Server } from 'http';
import { InvitationService } from '../../src/services/invitation-service';

jest.mock('../../src/services/invitation-service');
jest.mock('../../src/services/guardian-service');

const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;

const TASK_DEFINITION_PATH = path.resolve(__dirname, '../../../infra/task-definition.json');
const APEX_ORIGIN = 'https://hooplings.com';
const WWW_ORIGIN = 'https://www.hooplings.com';
const FOREIGN_ORIGIN = 'https://evil.example';
const ACCEPT_PATH = '/api/v1/invitations/by-token/abc123defghijklmnop/accept';

interface TaskDefinition {
  containerDefinitions: Array<{ environment?: Array<{ name: string; value: string }> }>;
}

function readProductionCorsOrigin(): string {
  const taskDefinition = JSON.parse(readFileSync(TASK_DEFINITION_PATH, 'utf8')) as TaskDefinition;
  const entry = taskDefinition.containerDefinitions
    .flatMap((container) => container.environment ?? [])
    .find((env) => env.name === 'CORS_ORIGIN');
  if (!entry) {
    throw new Error(`CORS_ORIGIN is missing from ${TASK_DEFINITION_PATH}`);
  }
  return entry.value;
}

describe('CORS allowlist (#447)', () => {
  const ORIGINAL_CORS_ORIGIN = process.env.CORS_ORIGIN;
  let app: Express;
  let httpServer: Server;
  let productionOrigins: string[];

  beforeAll(async () => {
    const productionValue = readProductionCorsOrigin();
    productionOrigins = productionValue.split(',').map((origin) => origin.trim());
    // index.ts reads CORS_ORIGIN at module load, so the env must be set before the import.
    process.env.CORS_ORIGIN = productionValue;
    const server = await import('../../src/index');
    app = server.app;
    httpServer = server.httpServer;
  });

  afterAll((done) => {
    if (ORIGINAL_CORS_ORIGIN === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = ORIGINAL_CORS_ORIGIN;
    httpServer.close(() => done());
  });

  describe('production value in infra/task-definition.json', () => {
    it('lists the web apex and www origins', () => {
      expect(productionOrigins).toContain(APEX_ORIGIN);
      expect(productionOrigins).toContain(WWW_ORIGIN);
    });

    it('contains only exact https origins and no wildcard', () => {
      expect(productionOrigins.length).toBeGreaterThan(0);
      for (const origin of productionOrigins) {
        expect(origin).not.toBe('*');
        expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
      }
    });
  });

  describe('preflight on the public accept route', () => {
    it.each([APEX_ORIGIN, WWW_ORIGIN])('allows a preflight from %s', async (origin) => {
      const res = await request(app)
        .options(ACCEPT_PATH)
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toMatch(/content-type/i);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('returns no Access-Control-Allow-Origin for an origin that is not listed', async () => {
      const res = await request(app)
        .options(ACCEPT_PATH)
        .set('Origin', FOREIGN_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('actual request on the public accept route', () => {
    beforeEach(() => {
      const acceptResult = {
        invitation: { id: 'b2c3d4e5-f6a7-4901-a345-67890abcdef0', status: 'ACCEPTED' },
        teamMember: { teamId: 'team-id', playerId: 'player-id' },
      };
      mockInvitationService.acceptInvitationByToken.mockResolvedValue(
        acceptResult as unknown as Awaited<ReturnType<typeof mockInvitationService.acceptInvitationByToken>>
      );
    });

    it('echoes the apex origin on the POST response', async () => {
      const res = await request(app)
        .post(ACCEPT_PATH)
        .set('Origin', APEX_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(APEX_ORIGIN);
      expect(res.headers['vary']).toMatch(/origin/i);
    });

    it('omits the header for a foreign origin but does not reject the request itself', async () => {
      const res = await request(app)
        .post(ACCEPT_PATH)
        .set('Origin', FOREIGN_ORIGIN);

      // cors() never 4xxs — the browser enforces the missing header. The route is a
      // bearer-token endpoint reachable from any curl, so this is hygiene, not authz.
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('serves a request with no Origin header (native mobile app) unchanged', async () => {
      const res = await request(app).post(ACCEPT_PATH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
