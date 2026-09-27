import { Prisma } from '@prisma/client';

/**
 * Spread into every `User` write that changes or removes `email` (#449).
 *
 * `emailSuppressedAt` / `emailSuppressedReason` describe the address that was
 * on the row when SES reported the bounce or complaint. A write that puts a
 * different address (or none) on the row must drop them, or the coach is told
 * that a brand-new address "bounced".
 */
export const EMAIL_SUPPRESSION_CLEARED = {
  emailSuppressedAt: null,
  emailSuppressedReason: null,
} satisfies Prisma.UserUpdateManyMutationInput;
