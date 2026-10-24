import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link href="/support">Support</Link>
      <span aria-hidden="true">·</span>
      <Link href="/privacy">Privacy</Link>
      <span aria-hidden="true">·</span>
      <Link href="/terms">Terms</Link>
    </footer>
  );
}
