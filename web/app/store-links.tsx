import { APP_STORE_RELEASED, APP_STORE_URL } from '../lib/open-in-app';

/**
 * The App Store button, or a "coming soon" line until the release (#451): the
 * id-only store URL shows Apple's "not available" page before then (#30).
 */
export function AppStoreLink({ compact = false }: { compact?: boolean }) {
  if (!APP_STORE_RELEASED) {
    return <p className="store-pending">The Hooplings iPhone app is coming soon to the App Store.</p>;
  }
  return (
    <a
      href={APP_STORE_URL}
      className={compact ? 'btn btn-outline' : 'btn btn-primary'}
      style={compact ? { fontSize: 14, padding: '10px 16px' } : undefined}
    >
      {compact ? 'App Store' : 'Download on the App Store'}
    </a>
  );
}
