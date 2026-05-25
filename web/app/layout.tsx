import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Basketball Tracker',
  description: 'Basketball team management app',
  // Invitation tokens appear in URLs (/invite/<token>). Suppress the Referer
  // header on outbound navigation so the token never leaks to third parties.
  referrer: 'no-referrer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
