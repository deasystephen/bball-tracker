/**
 * The developer login list (`GET /auth/dev-users`, development only).
 *
 * The list used to be ordered by role alone. Inside a role the database chose,
 * and its choice changed as rows were updated, so a Maestro flow that tapped a
 * user without scrolling could pass one day and fail the next on the same
 * data. Rows left behind by real-database tests were mixed in with everyone
 * else and pushed the fixtures off the first screen (#584).
 *
 * The order is now fixed: the accounts the seed creates for signing in come
 * first, then everything else; inside each group by role, then name, then id.
 */

import { UserRole } from '@prisma/client';
import prisma from '../../models';

export interface DevUser {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
}

/** Address domains of the accounts `prisma/seed.ts` creates for signing in. */
export const SEEDED_LOGIN_DOMAINS = ['example.com', 'bball-tracker.com'];

/**
 * The order the login screen has always shown roles in (it came from the order
 * of the enum in the database). Kept, so the flows find coaches and parents on
 * the first screen as before.
 */
export const DEV_USER_ROLE_ORDER: UserRole[] = [
  UserRole.COACH,
  UserRole.PARENT,
  UserRole.PLAYER,
  UserRole.ADMIN,
];

export function isSeededLogin(user: Pick<DevUser, 'email'>): boolean {
  const domain = user.email?.split('@')[1]?.toLowerCase();
  return domain !== undefined && SEEDED_LOGIN_DOMAINS.includes(domain);
}

/** Code-point comparison: the same on every machine, unlike `localeCompare`. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function orderDevUsers<T extends DevUser>(users: readonly T[]): T[] {
  const roleRank = (role: UserRole): number => {
    const rank = DEV_USER_ROLE_ORDER.indexOf(role);
    return rank === -1 ? DEV_USER_ROLE_ORDER.length : rank;
  };

  return [...users].sort(
    (a, b) =>
      Number(isSeededLogin(b)) - Number(isSeededLogin(a)) ||
      roleRank(a.role) - roleRank(b.role) ||
      compareText(a.name, b.name) ||
      compareText(a.id, b.id)
  );
}

export async function listDevUsers(): Promise<DevUser[]> {
  const users = await prisma.user.findMany({
    // Deleted accounts (#444) are tombstones with no email — never offer them
    where: { deletedAt: null },
    select: { id: true, email: true, name: true, role: true },
  });

  return orderDevUsers(users);
}
