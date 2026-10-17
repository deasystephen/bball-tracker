import { InviteClient } from './invite-client';
import { getInvitation } from '../../../lib/invitation-lookup';

export const dynamic = 'force-dynamic';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await getInvitation(token);

  if (result.kind === 'notFound') {
    return (
      <main className="container">
        <div className="card">
          <div className="logo">❌</div>
          <h1>Invitation Not Found</h1>
          <p>This invitation link is invalid or has been removed.</p>
          <p className="footer">If you believe this is an error, ask the team coach to resend the invitation.</p>
        </div>
      </main>
    );
  }

  if (result.kind === 'unavailable') {
    // No resend advice here: the link may still be valid, and a resend expires it.
    return (
      <main className="container">
        <div className="card">
          <div className="logo">⏳</div>
          <h1>Invitation Temporarily Unavailable</h1>
          {result.status === 429 ? (
            // Either limiter (per token or per IP) can answer 429, so no per-link claim.
            <p>There have been too many requests. Please wait a few minutes and try again.</p>
          ) : (
            <p>We couldn&apos;t load this invitation right now. Please try again in a few minutes.</p>
          )}
          <p className="footer">Your invitation link may still be valid.</p>
        </div>
      </main>
    );
  }

  return <InviteClient invitation={result.invitation} token={token} />;
}
