/**
 * GET /api/v1/auth/dev-users: the developer login list (#584).
 *
 * The list was ordered by role alone. Inside a role the database chose, and
 * rows left behind by real-database tests pushed the seeded logins off the
 * first screen, so Maestro flows failed for reasons outside the app.
 *
 * The route is mounted only when NODE_ENV is "development", so the router is
 * loaded in isolation with that setting and mounted on a bare app.
 */

import express, { type Express } from 'express';
import request from 'supertest';
import { mockPrisma } from '../setup';
import { DEV_USER_ROLE_ORDER, isSeededLogin, orderDevUsers, type DevUser } from '../../src/api/auth/dev-users';

const user = (id: string, name: string, role: DevUser['role'], email: string | null): DevUser => ({
  id,
  name,
  role,
  email,
});

// What a developer's database holds: seeded logins, seeded managed players
// with no address, and rows an interrupted test run left behind.
const STORED: DevUser[] = [
  user('t-2', 'coach-1a2b3c4d', 'COACH', 'coach.1a2b3c4d@example.test'),
  user('p-3', 'Steph Curry', 'PLAYER', 'steph.curry@example.com'),
  user('m-1', 'Bryce James', 'PLAYER', null),
  user('a-1', 'System Admin', 'ADMIN', 'admin@bball-tracker.com'),
  user('t-1', 'adminOnly-1a2b3c4d', 'COACH', 'adminOnly.1a2b3c4d@example.test'),
  user('c-2', 'Frank Vogel', 'COACH', 'frank.vogel@example.com'),
  user('g-1', 'Gloria James', 'PARENT', 'gloria.james@example.com'),
  user('p-1', 'Dana Whitfield', 'PLAYER', 'dana.whitfield@example.com'),
  user('c-1', 'Mike Brown', 'COACH', 'mike.brown@example.com'),
  user('t-3', 'kid-1a2b3c4d', 'PLAYER', 'Kid.1a2b3c4d@Example.Test'),
];

const EXPECTED_ORDER = [
  // seeded logins: coaches, parents, players, admin; by name inside a role
  'Frank Vogel',
  'Mike Brown',
  'Gloria James',
  'Dana Whitfield',
  'Steph Curry',
  'System Admin',
  // everything else, same rule
  'adminOnly-1a2b3c4d',
  'coach-1a2b3c4d',
  'Bryce James',
  'kid-1a2b3c4d',
];

const shuffled = <T>(items: readonly T[], seed: number): T[] => {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

describe('orderDevUsers', () => {
  it('puts seeded logins first, then by role, name and id', () => {
    expect(orderDevUsers(STORED).map((u) => u.name)).toEqual(EXPECTED_ORDER);
  });

  it('gives the same order whatever order the database returned', () => {
    for (const seed of [1, 7, 42, 2026, 99999]) {
      expect(orderDevUsers(shuffled(STORED, seed)).map((u) => u.name)).toEqual(EXPECTED_ORDER);
    }
  });

  it('keeps 26 leftover accounts from moving a single seeded login', () => {
    // The state of 2026-09-27: they filled the first screen of the list.
    const leftovers = Array.from({ length: 26 }, (_unused, i) =>
      user(`left-${i}`, `coach-${i.toString(16).padStart(8, '0')}`, 'COACH', `coach.${i}@example.test`)
    );

    const ordered = orderDevUsers([...leftovers, ...STORED]);

    expect(ordered.slice(0, 6).map((u) => u.name)).toEqual(EXPECTED_ORDER.slice(0, 6));
  });

  it('breaks a tie of role and name by id', () => {
    const twins = [
      user('b', 'Same Name', 'PLAYER', 'two@example.com'),
      user('a', 'Same Name', 'PLAYER', 'one@example.com'),
    ];

    expect(orderDevUsers(twins).map((u) => u.id)).toEqual(['a', 'b']);
    expect(orderDevUsers([...twins].reverse()).map((u) => u.id)).toEqual(['a', 'b']);
  });

  it('does not change the list it is given', () => {
    const input = [...STORED];
    orderDevUsers(input);
    expect(input).toEqual(STORED);
  });

  it('shows roles in the order the login screen always has', () => {
    expect(DEV_USER_ROLE_ORDER).toEqual(['COACH', 'PARENT', 'PLAYER', 'ADMIN']);
  });
});

describe('isSeededLogin', () => {
  it.each([
    ['frank.vogel@example.com', true],
    ['admin@bball-tracker.com', true],
    ['Frank.Vogel@EXAMPLE.COM', true],
    ['coach.1a2b3c4d@example.test', false],
    ['someone@example.com.evil.test', false],
    ['someone@notexample.com', false],
    ['no-at-sign', false],
    [null, false],
  ])('%s -> %s', (email, expected) => {
    expect(isSeededLogin({ email })).toBe(expected);
  });
});

describe('GET /api/v1/auth/dev-users', () => {
  const previousEnv = process.env.NODE_ENV;
  let app: Express;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    await jest.isolateModulesAsync(async () => {
      const { default: router } = await import('../../src/api/auth/routes');
      app = express();
      app.use(express.json());
      app.use('/api/v1/auth', router);
    });
    process.env.NODE_ENV = previousEnv;
  });

  it('answers in the same order on two calls, seeded logins first', async () => {
    (mockPrisma.user.findMany as jest.Mock)
      .mockResolvedValueOnce(shuffled(STORED, 3))
      .mockResolvedValueOnce(shuffled(STORED, 11));

    const first = await request(app).get('/api/v1/auth/dev-users');
    const second = await request(app).get('/api/v1/auth/dev-users');

    expect(first.status).toBe(200);
    expect(first.body.users.map((u: DevUser) => u.name)).toEqual(EXPECTED_ORDER);
    expect(second.body.users).toEqual(first.body.users);
  });

  it('leaves deleted accounts out and returns only what the list shows', async () => {
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValueOnce(STORED);

    const response = await request(app).get('/api/v1/auth/dev-users');

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      select: { id: true, email: true, name: true, role: true },
    });
    expect(Object.keys(response.body.users[0]).sort()).toEqual(['email', 'id', 'name', 'role']);
  });

  it('answers 500 when the database fails', async () => {
    (mockPrisma.user.findMany as jest.Mock).mockRejectedValueOnce(new Error('connection refused'));

    const response = await request(app).get('/api/v1/auth/dev-users');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to list users' });
  });
});
