/**
 * Which roster records a CHILD join request can be approved onto (#1072).
 *
 * A coach who already typed the roster approves a parent's request onto the
 * child's existing record instead of creating a duplicate. The server's rule
 * (`JoinLinkService.approveRequest` with `playerId`): a managed record (no
 * login), not deleted, on this team, with no parent or guardian linked yet.
 * The API re-checks it under its locks and answers 409
 * `join_player_unavailable` when the record was taken meanwhile; this list only
 * decides what the coach is offered.
 *
 * `team.guardianLinkedPlayerIds` (roster managers only) lists the members with
 * at least one guardian link. Records whose name matches the typed child's
 * name come first, then the rest by name (`sortRosterMembers`).
 */

import type { Team, TeamMember } from '../hooks/useTeams';
import { sortRosterMembers } from './roster-sort';

/** Names compared the way a coach reads them: trimmed, inner whitespace collapsed, case ignored. */
function foldName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function attachablePlayers(
  team: Pick<Team, 'members' | 'guardianLinkedPlayerIds'>,
  childName: string | null
): TeamMember[] {
  const linked = new Set(team.guardianLinkedPlayerIds ?? []);
  const candidates = (team.members ?? []).filter(
    (member) => member.player.isManaged && member.player.deletedAt == null && !linked.has(member.playerId)
  );
  const sorted = sortRosterMembers(candidates, 'name');
  if (!childName) {
    return sorted;
  }
  const wanted = foldName(childName);
  const matching = sorted.filter((member) => foldName(member.player.name) === wanted);
  return [...matching, ...sorted.filter((member) => foldName(member.player.name) !== wanted)];
}
