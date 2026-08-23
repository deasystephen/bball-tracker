/**
 * Zod schemas for auth routes
 */

import { z } from 'zod';

/**
 * Roles a user may pick for themselves. ADMIN is assigned from ADMIN_EMAIL at
 * first sign-up; PARENT is reserved for the managed-player flow. Neither is
 * self-selectable.
 */
export const SELF_SELECTABLE_ROLES = ['PLAYER', 'COACH'] as const;
export type SelfSelectableRole = (typeof SELF_SELECTABLE_ROLES)[number];

export const updateRoleSchema = z.object({
  role: z.enum(SELF_SELECTABLE_ROLES, {
    message: "Role must be 'PLAYER' or 'COACH'",
  }),
});

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
