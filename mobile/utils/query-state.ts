/**
 * Load-state predicates shared by screens that render TanStack Query results.
 */

/** The parts of a query result the predicates read. */
export interface QueryErrorState {
  error: unknown;
  data: unknown;
}

/**
 * Whether a screen should replace its content with `ErrorState` (#728).
 *
 * A failed request is never an empty result, but a failed background refetch keeps
 * the cached data, which is still worth showing; so the error wins only when the
 * query has nothing to show.
 */
export function showQueryError({ error, data }: QueryErrorState): boolean {
  return error != null && data === undefined;
}

/**
 * Whether a failed lookup says nothing about the thing looked up, so the screen should
 * offer a retry instead of "not found" (#892, the mobile twin of the web invite page's
 * `unavailable` result, #720). Only a 400 or 404 means the resource is gone: a network
 * failure (no response), a 429 and any 5xx are transient. Any other status keeps the
 * not-found state.
 */
export function isTransientLoadError(error: unknown): boolean {
  if (error == null) return false;
  const status = (error as { response?: { status?: number } }).response?.status;
  if (status === undefined) return true;
  return status === 429 || status >= 500;
}
