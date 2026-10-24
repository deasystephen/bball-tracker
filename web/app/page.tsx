import { AppStoreLink } from './store-links';

export default function Home() {
  return (
    <main className="container">
      <div className="card">
        <div className="logo">🏀</div>
        <h1>Hooplings</h1>
        <p>Track your team&apos;s stats, games, and performance in real time.</p>
        <div className="actions" style={{ marginTop: 24 }}>
          <AppStoreLink />
        </div>
      </div>
    </main>
  );
}
