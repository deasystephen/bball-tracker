'use client';

import { useState } from 'react';
import { childDisplayName, inviterDisplayName } from '../../../lib/display-name';
import { CLIENT_HEADERS, acceptInvitationByTokenUrl } from '../../../lib/api-urls';
import { formatExpiry } from '../../../lib/format-date';
import type { GuardianInvitationDetails, InvitationDetails } from '../../../lib/invitation-types';
import { APP_STORE_RELEASED, openInApp } from '../../../lib/open-in-app';
import { AppStoreLink } from '../../store-links';


interface Props {
  invitation: InvitationDetails;
  token: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date();
}

const RELATIONSHIP_LABEL: Record<GuardianInvitationDetails['relationship'], string> = {
  MOTHER: 'mother',
  FATHER: 'father',
  GUARDIAN: 'guardian',
  OTHER: 'guardian',
};

export function InviteClient({ invitation, token }: Props) {
  const [acceptState, setAcceptState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const expired = isExpired(invitation.expiresAt);
  const isPending = invitation.status === 'PENDING' && !expired;
  const guardian = invitation.kind === 'guardian' ? invitation : null;
  const teamInvite = invitation.kind === 'guardian' ? null : invitation;
  // Tombstoned child: label from deletedAt, never from the stored name (#894).
  const childLabel = guardian ? childDisplayName(guardian) : '';
  const childRole = guardian ? `${childLabel}'s ${RELATIONSHIP_LABEL[guardian.relationship]}` : '';
  // What the invitation is "to" / "for" in the status copy below.
  const subject = guardian ? (
    <>
      <strong>{childLabel}</strong>
      {guardian.teamName ? <> ({guardian.teamName})</> : null}
    </>
  ) : (
    <strong>{invitation.teamName}</strong>
  );
  const preposition = guardian ? 'for' : 'to';

  async function acceptWithoutApp() {
    setAcceptState('loading');
    setErrorMessage('');
    try {
      const res = await fetch(acceptInvitationByTokenUrl(API_URL, token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS },
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setErrorMessage(data.error ?? 'Something went wrong. Please try again.');
        setAcceptState('error');
        return;
      }
      setAcceptState('done');
    } catch {
      setErrorMessage('Network error. Please check your connection and try again.');
      setAcceptState('error');
    }
  }

  if (acceptState === 'done') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">✅</div>
          <p className="success-state">
            {guardian
              ? `You are now ${childRole}!`
              : `You've joined ${invitation.teamName}!`}
          </p>
          {/* No "download the app" before the release: there is nothing to download yet. */}
          {APP_STORE_RELEASED && (
            <p>
              {guardian
                ? "Download the app to see your child's schedule, RSVP for games, and view stats."
                : 'Download the app to see your team, track games, and view stats.'}
            </p>
          )}
          <div className="actions" style={{ marginTop: 24 }}>
            <AppStoreLink />
          </div>
        </div>
      </main>
    );
  }

  if (invitation.status === 'ACCEPTED') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">✅</div>
          <span className="status-badge status-accepted">Accepted</span>
          <h1>Already Accepted</h1>
          <p>This invitation {preposition} {subject} has already been accepted.</p>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => openInApp(token)}>Open in App</button>
          </div>
        </div>
      </main>
    );
  }

  if (invitation.status === 'REJECTED') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">🚫</div>
          <span className="status-badge status-rejected">Rejected</span>
          <h1>Invitation Declined</h1>
          <p>This invitation {preposition} {subject} was declined.</p>
        </div>
      </main>
    );
  }

  if (invitation.status === 'CANCELLED') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">🚫</div>
          <span className="status-badge status-cancelled">Cancelled</span>
          <h1>Invitation Cancelled</h1>
          <p>This invitation {preposition} {subject} has been cancelled by the team coach.</p>
        </div>
      </main>
    );
  }

  if (invitation.status === 'EXPIRED' || expired) {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">⏰</div>
          <span className="status-badge status-expired">Expired</span>
          <h1>Invitation Expired</h1>
          <p>
            This invitation {preposition} {subject} expired on{' '}
            {formatExpiry(invitation.expiresAt)}.
          </p>
          <p className="footer">
            {guardian?.childDeletedAt
              ? "This player's record was removed."
              : 'Ask the team coach to send a new invitation.'}
          </p>
        </div>
      </main>
    );
  }

  // PENDING — main happy path
  return (
    <main className="container">
      <div className="card">
        <div className="logo">{guardian ? '👨‍👧' : '🏀'}</div>
        <h1>
          {guardian
            ? `You're invited to be ${childRole}`
            : "You're invited to join a team!"}
        </h1>

        <div className="invite-meta">
          {guardian ? (
            <>
              <div className="invite-meta-row">
                <span className="meta-label">Child</span>
                <span className="meta-value">{childLabel}</span>
              </div>
              <div className="invite-meta-row">
                <span className="meta-label">Relationship</span>
                <span className="meta-value">{RELATIONSHIP_LABEL[guardian.relationship]}</span>
              </div>
              {guardian.teamName && (
                <div className="invite-meta-row">
                  <span className="meta-label">Team</span>
                  <span className="meta-value">{guardian.teamName}</span>
                </div>
              )}
            </>
          ) : (
            <div className="invite-meta-row">
              <span className="meta-label">Team</span>
              <span className="meta-value">{invitation.teamName}</span>
            </div>
          )}
          <div className="invite-meta-row">
            <span className="meta-label">From</span>
            <span className="meta-value">
              {inviterDisplayName(invitation)}
            </span>
          </div>
          {teamInvite?.position && (
            <div className="invite-meta-row">
              <span className="meta-label">Position</span>
              <span className="meta-value">{teamInvite.position}</span>
            </div>
          )}
          {teamInvite?.jerseyNumber != null && (
            <div className="invite-meta-row">
              <span className="meta-label">Jersey</span>
              <span className="meta-value">#{teamInvite.jerseyNumber}</span>
            </div>
          )}
          <div className="invite-meta-row">
            <span className="meta-label">Expires</span>
            <span className="meta-value">{formatExpiry(invitation.expiresAt)}</span>
          </div>
        </div>

        {teamInvite?.message && (
          <p className="invite-message">&ldquo;{teamInvite.message}&rdquo;</p>
        )}

        {isPending && (
          <div className="actions">
            <button className="btn btn-primary" onClick={() => openInApp(token)}>
              Open in App
            </button>

            <div className="divider">or</div>

            <button
              className="btn btn-outline"
              onClick={acceptWithoutApp}
              disabled={acceptState === 'loading'}
            >
              {acceptState === 'loading'
                ? 'Accepting…'
                : guardian
                  ? `Accept for ${childLabel}`
                  : 'Accept without app'}
            </button>

            {acceptState === 'error' && (
              <p className="error-msg">{errorMessage}</p>
            )}
          </div>
        )}

        <div className="store-links">
          <p className="footer">Don&apos;t have the app?</p>
          <AppStoreLink compact />
        </div>
      </div>
    </main>
  );
}
