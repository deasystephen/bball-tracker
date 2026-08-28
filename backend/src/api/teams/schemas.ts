/**
 * Zod validation schemas for Teams API
 */

import { z } from 'zod';
import { GuardianRelationship } from '@prisma/client';
import { safeUrlSchema } from '../auth/schemas';

/**
 * Schema for creating a new team
 */
export const createTeamSchema = z.object({
  name: z.string().min(1, 'Team name is required').max(100, 'Team name too long'),
  seasonId: z.string().uuid('Invalid season ID format'),
  chatLink: z.string().url().refine(
    (url) => url.startsWith('https://') || url.startsWith('http://'),
    { message: 'Chat link must use http or https protocol' }
  ).optional(),
});

/**
 * Schema for updating a team
 */
export const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  seasonId: z.string().uuid().optional(),
  chatLink: z.string().url().refine(
    (url) => url.startsWith('https://') || url.startsWith('http://'),
    { message: 'Chat link must use http or https protocol' }
  ).nullable().optional(),
});

/**
 * Schema for adding a player to a team
 */
export const addPlayerSchema = z.object({
  playerId: z.string().uuid('Invalid player ID format'),
  jerseyNumber: z.number().int().min(0).max(99).optional(),
  position: z.string().max(50).optional(),
});

/**
 * Schema for updating a team member
 */
export const updateTeamMemberSchema = z.object({
  jerseyNumber: z.number().int().min(0).max(99).optional(),
  position: z.string().max(50).optional(),
});

/**
 * Default staff role types assignable through the staff API. CUSTOM roles are
 * created via createCustomRole and are not assignable here.
 */
export const staffRoleTypeSchema = z.enum(['HEAD_COACH', 'ASSISTANT_COACH', 'TEAM_MANAGER'], {
  message: 'roleType must be one of HEAD_COACH, ASSISTANT_COACH, TEAM_MANAGER',
});

/**
 * Schema for adding a staff member to a team.
 * Exactly one of `userId` / `email` identifies an EXISTING user.
 */
export const addStaffSchema = z
  .object({
    userId: z.string().uuid('Invalid user ID format').optional(),
    email: z.string().email('Invalid email format').max(255).optional(),
    roleType: staffRoleTypeSchema,
  })
  .refine((d) => (d.userId ? 1 : 0) + (d.email ? 1 : 0) === 1, {
    message: 'Provide exactly one of userId or email',
  });

/**
 * Schema for changing a staff member's role
 */
export const updateStaffRoleSchema = z.object({
  roleType: staffRoleTypeSchema,
});

/**
 * Schema for creating a custom team role
 */
export const createRoleSchema = z.object({
  name: z.string().min(1, 'Role name is required').max(50, 'Role name too long'),
  description: z.string().max(255).optional(),
  canManageTeam: z.boolean().optional().default(false),
  canManageRoster: z.boolean().optional().default(false),
  canTrackStats: z.boolean().optional().default(false),
  canViewStats: z.boolean().optional().default(true),
  canShareStats: z.boolean().optional().default(false),
});

/**
 * Schema for team query parameters
 */
export const teamQuerySchema = z.object({
  seasonId: z.string().uuid().optional(),
  leagueId: z.string().min(1).optional(),
  playerId: z.string().uuid().optional(), // Teams where this player is a member
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Schema for creating a managed player (no email/account required)
 */
export const createManagedPlayerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  jerseyNumber: z.number().int().min(0).max(99).optional(),
  position: z.string().max(50).optional(),
  profilePictureUrl: z.string().url().refine(
    (url) => url.startsWith('https://') || url.startsWith('http://'),
    { message: 'URL must use http or https protocol' }
  ).optional(),
});

/**
 * Unified Add Player (roster/invite unification spec,
 * docs/plans/roster-invite-unification-spec.md).
 *
 * Name is always required. `playerEmail` decides whether an invitation goes
 * out; `guardianEmail` (+ `guardianRelationship`) additionally invites a
 * parent/guardian for players who get a roster entry at creation.
 */
export const addRosterPlayerSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name too long'),
    playerEmail: z.string().trim().email('Invalid player email format').max(255).optional(),
    guardianEmail: z.string().trim().email('Invalid guardian email format').max(255).optional(),
    guardianRelationship: z
      .nativeEnum(GuardianRelationship, {
        error: 'Relationship must be MOTHER, FATHER, GUARDIAN or OTHER',
      })
      .optional(),
    jerseyNumber: z.number().int().min(0).max(99).optional(),
    position: z.string().max(50).optional(),
    profilePictureUrl: safeUrlSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.guardianEmail && !data.guardianRelationship) {
      ctx.addIssue({
        code: 'custom',
        message: 'guardianRelationship is required when guardianEmail is provided',
      });
    }
    if (data.guardianRelationship && !data.guardianEmail) {
      ctx.addIssue({
        code: 'custom',
        message: 'guardianEmail is required when guardianRelationship is provided',
      });
    }
    if (
      data.playerEmail &&
      data.guardianEmail &&
      data.playerEmail.toLowerCase() === data.guardianEmail.toLowerCase()
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Player and guardian emails must be different',
      });
    }
  });

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type AddRosterPlayerInput = z.infer<typeof addRosterPlayerSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddPlayerInput = z.infer<typeof addPlayerSchema>;
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;
export type StaffRoleType = z.infer<typeof staffRoleTypeSchema>;
export type AddStaffInput = z.infer<typeof addStaffSchema>;
export type UpdateStaffRoleInput = z.infer<typeof updateStaffRoleSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type TeamQueryParams = z.infer<typeof teamQuerySchema>;
export type CreateManagedPlayerInput = z.infer<typeof createManagedPlayerSchema>;

/**
 * Schema for creating an announcement
 */
export const createAnnouncementSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title too long'),
  body: z.string().min(1, 'Body is required').max(5000, 'Body too long'),
});

/**
 * Schema for announcement list query parameters.
 * Mirrors the other list schemas: bounded limit (1-100), non-negative offset.
 */
export const announcementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
export type AnnouncementQueryParams = z.infer<typeof announcementQuerySchema>;
