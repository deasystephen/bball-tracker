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
