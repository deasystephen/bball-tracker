import prisma from '../models';

/**
 * Everyone a team-wide message goes to: rostered players, staff, and the
 * guardians of rostered players — deduplicated (a parent who is also staff is
 * one recipient), minus `excludeUserId` (the author).
 *
 * Single definition for both channels: push (`NotificationService.sendToTeam`)
 * and email (`AnnouncementService.createAnnouncement`). Before #449 the email
 * side kept its own list — players only — so guardians got the push and never
 * the email.
 */
export async function getTeamAudienceUserIds(
  teamId: string,
  excludeUserId?: string
): Promise<string[]> {
  const [members, staff] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId },
      select: { playerId: true },
    }),
    prisma.teamStaff.findMany({
      where: { teamId },
      select: { userId: true },
    }),
  ]);

  const memberIds = members.map((m) => m.playerId);

  const guardians =
    memberIds.length > 0
      ? await prisma.guardian.findMany({
          where: { childId: { in: memberIds } },
          select: { parentId: true },
        })
      : [];

  const userIds = new Set([
    ...memberIds,
    ...staff.map((s) => s.userId),
    ...guardians.map((g) => g.parentId),
  ]);

  if (excludeUserId) {
    userIds.delete(excludeUserId);
  }

  return [...userIds];
}
