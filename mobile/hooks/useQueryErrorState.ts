import { useCallback, useEffect, useState } from 'react';
import { describeApiError, getApiErrorMessage } from '../services/api-client';
import { showQueryError } from '../utils/query-state';

interface QueryErrorInput {
  error: unknown;
  data: unknown;
  refetch: () => unknown;
}

export interface QueryErrorState {
  /** The query failed with nothing to show: render `ErrorState` (`showQueryError`). */
  failed: boolean;
  /** The user pressed Try Again and the refetch has not settled: render the spinner. */
  retrying: boolean;
  /** The message for `ErrorState`. */
  message: string;
  /** The `onRetry` handler. */
  retry: () => void;
}

/**
 * The error-vs-content decision of a data screen (#888), shared by every tab.
 *
 * - `failed` is `showQueryError`: a failed background refetch keeps the cached data.
 * - `message` is derived on every render, but the catalogued `error_shown` event is sent
 *   from an effect keyed on the error, so it fires once per failure (not in render, where
 *   StrictMode runs it twice).
 * - `retrying` is true only between a press on Try Again and the refetch settling.
 *   TanStack keeps `error` set while a retry is in flight, so the screen shows the spinner
 *   then; an automatic refetch (reconnect, focus) must not flip the error to a spinner.
 */
export function useQueryErrorState(
  { error, data, refetch }: QueryErrorInput,
  fallbackMessage: string
): QueryErrorState {
  const failed = showQueryError({ error, data });
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (failed) getApiErrorMessage(error, fallbackMessage);
  }, [failed, error, fallbackMessage]);

  const retry = useCallback(() => {
    setRetrying(true);
    Promise.resolve(refetch()).finally(() => setRetrying(false));
  }, [refetch]);

  return {
    failed,
    retrying: retrying && failed,
    message: failed ? describeApiError(error, fallbackMessage) : '',
    retry,
  };
}
