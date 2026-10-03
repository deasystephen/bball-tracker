/**
 * Per-request log context carried on an AsyncLocalStorage store.
 *
 * `requestContext` (api/middleware/request-context.ts) opens a store for every
 * HTTP request with its `requestId`; `authenticate` adds the `userId` once the
 * bearer token resolves. `utils/logger.ts` merges the store into every log
 * entry written while the request is being handled, so a service method can
 * log a domain event with ids only and the line still carries the request it
 * belongs to (#617). Explicit context passed to the logger always wins.
 *
 * Socket.io handlers and background work (SES consumer, push receipts) run
 * outside any store; their lines carry only what they pass explicitly.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface LogContextStore {
  requestId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<LogContextStore>();

/** Run `fn` with `store` as the ambient log context. */
export function runWithLogContext<T>(store: LogContextStore, fn: () => T): T {
  return storage.run(store, fn);
}

/** The ambient log context, or `undefined` outside a request. */
export function getLogContext(): LogContextStore | undefined {
  return storage.getStore();
}

/** Attach the authenticated user to the ambient context (no-op outside a request). */
export function setLogContextUser(userId: string): void {
  const store = storage.getStore();
  if (store) {
    store.userId = userId;
  }
}
