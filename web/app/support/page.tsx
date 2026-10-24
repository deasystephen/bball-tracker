import type { Metadata } from 'next';
import { SUPPORT_EMAIL } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Support · Hooplings',
  description: 'Get help with Hooplings.',
};

// The App Store Support URL (#450, #451).
export default function SupportPage() {
  return (
    <main className="container">
      <div className="card text-page">
        <h1>Hooplings Support</h1>
        <p>
          Questions, problems or feedback? Email us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. A person reads every message, and we
          usually answer within two business days.
        </p>
        <p>
          In the app, <strong>Profile → About → Contact support</strong> opens a message to the same address
          with your app version filled in, which helps us find the problem faster.
        </p>

        <h2>Common questions</h2>
        <h3>I got an invitation but the link does nothing</h3>
        <p>
          Open the link on your phone. If the app is installed it opens there; otherwise the invitation page
          lets you accept in the browser. If the page says the invitation was not found or has expired, ask the
          coach to send a new one.
        </p>
        <h3>How do I delete my account?</h3>
        <p>
          In the app, go to <strong>Profile → Delete account</strong>. If you can no longer sign in, email us
          from the address on the account and we will handle the request.
        </p>
        <h3>I am a parent. How do I follow my child&apos;s team?</h3>
        <p>
          Ask the coach to invite you as a parent or guardian from the team roster. You will get an email with
          a link to accept.
        </p>
      </div>
    </main>
  );
}
