'use client';

import { useState } from 'react';

interface InvitationDetails {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  teamName: string;
  inviterName: string;
  position: string | null;
  jerseyNumber: number | null;
  message: string | null;
  expiresAt: string;
}

interface Props {
  invitation: InvitationDetails;
  token: string;
}

const APP_STORE_URL = 'https://apps.apple.com/app/basketball-tracker/id000000000';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.bballtracker.mobile';
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date();
}

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function InviteClient({ invitation, token }: Props) {
  const [acceptState, setAcceptState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const expired = isExpired(invitation.expiresAt);
  const isPending = invitation.status === 'PENDING' && !expired;

  function openInApp() {
    const deepLink = `bball-tracker://invite/${token}`;
    const ua = navigator.userAgent;
    const isAndroid = /android/i.test(ua);
    const isIos = /iphone|ipad|ipod/i.test(ua);
    const storeUrl = isAndroid ? PLAY_STORE_URL : APP_STORE_URL;

    let appOpened = false;
    const onHide = () => { appOpened = true; };
    document.addEventListener('visibilitychange', onHide);

    window.location.href = deepLink;

    setTimeout(() => {
      document.removeEventListener('visibilitychange', onHide);
      if (!appOpened && (isAndroid || isIos)) {
        window.location.href = storeUrl;
      }
    }, 1500);
  }

  async function acceptWithoutApp() {
    setAcceptState('loading');
    setErrorMessage('');
    try {
      const res = await fetch(`${API_URL}/api/v1/invitations/by-token/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          <p className="success-state">You&apos;ve joined {invitation.teamName}!</p>
          <p>Download the app to see your team, track games, and view stats.</p>
          <div className="actions" style={{ marginTop: 24 }}>
            <a href={APP_STORE_URL} className="btn btn-primary">Download on the App Store</a>
            <a href={PLAY_STORE_URL} className="btn btn-outline">Get it on Google Play</a>
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
          <p>This invitation to <strong>{invitation.teamName}</strong> has already been accepted.</p>
          <div className="actions">
            <button className="btn btn-primary" onClick={openInApp}>Open in App</button>
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
          <p>This invitation to <strong>{invitation.teamName}</strong> was declined.</p>
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
          <p>This invitation to <strong>{invitation.teamName}</strong> has been cancelled by the team coach.</p>
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
            This invitation to <strong>{invitation.teamName}</strong> expired on{' '}
            {formatExpiry(invitation.expiresAt)}.
          </p>
          <p className="footer">Ask the team coach to send a new invitation.</p>
        </div>
      </main>
    );
  }

  // PENDING — main happy path
  return (
    <main className="container">
      <div className="card">
        <div className="logo">🏀</div>
        <h1>You&apos;re invited to join a team!</h1>

        <div className="invite-meta">
          <div className="invite-meta-row">
            <span className="meta-label">Team</span>
            <span className="meta-value">{invitation.teamName}</span>
          </div>
          <div className="invite-meta-row">
            <span className="meta-label">From</span>
            <span className="meta-value">{invitation.inviterName}</span>
          </div>
          {invitation.position && (
            <div className="invite-meta-row">
              <span className="meta-label">Position</span>
              <span className="meta-value">{invitation.position}</span>
            </div>
          )}
          {invitation.jerseyNumber != null && (
            <div className="invite-meta-row">
              <span className="meta-label">Jersey</span>
              <span className="meta-value">#{invitation.jerseyNumber}</span>
            </div>
          )}
          <div className="invite-meta-row">
            <span className="meta-label">Expires</span>
            <span className="meta-value">{formatExpiry(invitation.expiresAt)}</span>
          </div>
        </div>

        {invitation.message && (
          <p className="invite-message">&ldquo;{invitation.message}&rdquo;</p>
        )}

        {isPending && (
          <div className="actions">
            <button className="btn btn-primary" onClick={openInApp}>
              Open in App
            </button>

            <div className="divider">or</div>

            <button
              className="btn btn-outline"
              onClick={acceptWithoutApp}
              disabled={acceptState === 'loading'}
            >
              {acceptState === 'loading' ? 'Accepting…' : 'Accept without app'}
            </button>

            {acceptState === 'error' && (
              <p className="error-msg">{errorMessage}</p>
            )}
          </div>
        )}

        <div className="store-links">
          <p className="footer">Don&apos;t have the app?</p>
          <a href={APP_STORE_URL} className="btn btn-outline" style={{ fontSize: 14, padding: '10px 16px' }}>
            App Store
          </a>
          <a href={PLAY_STORE_URL} className="btn btn-outline" style={{ fontSize: 14, padding: '10px 16px' }}>
            Google Play
          </a>
        </div>
      </div>
    </main>
  );
}
