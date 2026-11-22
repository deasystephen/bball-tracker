import { JoinClient } from './join-client';
import { getJoinLink } from '../../../lib/join-lookup';
import { AppStoreLink } from '../../store-links';

export const dynamic = 'force-dynamic';

/**
 * The page behind a team join link (#210), `hooplings.com/join/<token>`.
 *
 * A join link names nobody and is shared with a whole team, so this page only
 * says which team it is for and sends the visitor to the app, where a
 * signed-in adult asks to join and a coach approves. Nothing can be accepted
 * here (there is no "join without the app"), and nothing about the team but
 * its name is shown.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await getJoinLink(token);

  if (result.kind === 'notFound') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">❌</div>
          <h1>Join Link Not Found</h1>
          <p>This link is not valid, or the coach replaced it with a new one.</p>
          <p className="footer">Ask the team coach for the team&apos;s current join link.</p>
        </div>
      </main>
    );
  }

  if (result.kind === 'unavailable') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">⏳</div>
          <h1>Join Link Temporarily Unavailable</h1>
          {result.status === 429 ? (
            <p>There have been too many requests. Please wait a few minutes and try again.</p>
          ) : (
            <p>We couldn&apos;t load this join link right now. Please try again in a few minutes.</p>
          )}
          <p className="footer">Your join link may still be valid.</p>
        </div>
      </main>
    );
  }

  const { link } = result;

  if (link.state !== 'active') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">⏰</div>
          <span className="status-badge status-expired">{link.state === 'expired' ? 'Expired' : 'Full'}</span>
          <h1>{link.state === 'expired' ? 'Join Link Expired' : 'Join Link Is Full'}</h1>
          <p>
            This link to join <strong>{link.teamName}</strong> no longer takes requests.
          </p>
          <p className="footer">Ask the team coach for a new join link.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <div className="card">
        <div className="logo">🏀</div>
        <h1>Join {link.teamName}</h1>
        <p>
          Open this link in the Hooplings app to ask to join the team. A coach approves each request before anyone
          is added.
        </p>
        <p>
          Parents and guardians: sign in with your own account and add your child. Children don&apos;t get their own
          login.
        </p>

        <JoinClient token={token} />

        <div className="store-links">
          <p className="footer">Don&apos;t have the app?</p>
          <AppStoreLink compact />
        </div>
      </div>
    </main>
  );
}
