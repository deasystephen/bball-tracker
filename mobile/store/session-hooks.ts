/**
 * Registry for logout side effects.
 *
 * The auth store owns session *state*; the side effects of ending a session
 * (push-token unregister, WorkOS revocation, socket reset, query-cache clear)
 * live in `services/session-logout.ts`, which imports the api-client — which
 * imports the auth store. This tiny module breaks that cycle: the store only
 * knows the registry, and `services/session-logout.ts` registers itself when
 * loaded (it is imported for that side effect from `app/_layout.tsx`).
 */

export interface SessionHooks {
  /** Best-effort network steps, run while the access token is still stored. */
  remoteLogout?: () => Promise<void>;
  /** Synchronous local cleanup, run after the store has been cleared. */
  localCleanup?: () => void;
}

let hooks: SessionHooks = {};

export function setSessionHooks(next: SessionHooks): void {
  hooks = { ...hooks, ...next };
}

export function getSessionHooks(): SessionHooks {
  return hooks;
}
