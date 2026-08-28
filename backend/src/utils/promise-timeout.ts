/**
 * Bound a promise with a timeout.
 *
 * Added for awaited email sends in request paths (roster/invite unification):
 * `emailSent` reporting must never let a hung SES connection hold a request
 * for the SDK's full retry budget. The underlying operation is NOT cancelled —
 * for best-effort work (email) that is fine: the caller reports failure and
 * moves on, the send may still land.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    // Never keep the process alive just for a pending timeout guard
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
