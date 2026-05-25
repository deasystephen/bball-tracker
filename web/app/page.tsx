export default function Home() {
  return (
    <main className="container">
      <div className="card">
        <div className="logo">🏀</div>
        <h1>Basketball Tracker</h1>
        <p>Track your team&apos;s stats, games, and performance in real time.</p>
        <div className="actions" style={{ marginTop: 24 }}>
          <a
            href="https://apps.apple.com/app/basketball-tracker/id000000000"
            className="btn btn-primary"
          >
            Download on the App Store
          </a>
          <a
            href="https://play.google.com/store/apps/details?id=com.bballtracker.mobile"
            className="btn btn-outline"
          >
            Get it on Google Play
          </a>
        </div>
      </div>
    </main>
  );
}
