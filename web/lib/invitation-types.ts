/**
 * `GET /invitations/by-token/:token` is polymorphic: a team invitation
 * (`kind: 'team'`, or no `kind` on older API builds) or a guardian invitation
 * (`kind: 'guardian'` — PARENT role, docs/plans/parent-role-spec.md).
 */
export interface TeamInvitationDetails {
  kind?: 'team';
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  teamName: string;
  inviterName: string;
  /** Sender's tombstone signal (#642); label from this, never from `inviterName`. */
  inviterDeletedAt: string | null;
  position: string | null;
  jerseyNumber: number | null;
  message: string | null;
  expiresAt: string;
}

export interface GuardianInvitationDetails {
  kind: 'guardian';
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  childName: string;
  teamName: string | null;
  inviterName: string;
  /** Sender's tombstone signal; the backend half lands with PR #875. */
  inviterDeletedAt: string | null;
  relationship: 'MOTHER' | 'FATHER' | 'GUARDIAN' | 'OTHER';
  expiresAt: string;
}

export type InvitationDetails = TeamInvitationDetails | GuardianInvitationDetails;
