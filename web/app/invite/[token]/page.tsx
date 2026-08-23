import { InviteClient, type InvitationDetails } from './invite-client';

export const dynamic = 'force-dynamic';

async function getInvitation(token: string): Promise<InvitationDetails | null> {
  const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${apiUrl}/api/v1/invitations/by-token/${token}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json() as { success: boolean; invitation: InvitationDetails };
    return data.invitation ?? null;
  } catch {
    return null;
  }
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await getInvitation(token);

  if (!invitation) {
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

  return <InviteClient invitation={invitation} token={token} />;
}
