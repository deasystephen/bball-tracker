'use client';

import { openJoinInApp } from '../../../lib/open-in-app';

/** The one interactive element of the join page: hand the link to the app. */
export function JoinClient({ token }: { token: string }) {
  return (
    <div className="actions">
      <button className="btn btn-primary" onClick={() => openJoinInApp(token)}>
        Open in App
      </button>
    </div>
  );
}
