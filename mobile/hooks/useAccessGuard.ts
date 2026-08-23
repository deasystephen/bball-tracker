import { useEffect, useRef } from 'react';
import { useRouter, type Href } from 'expo-router';
import { useToast } from '../components/Toast';

export interface AccessGuardOptions {
  /** Where to go when the stack cannot pop (or always, with `mode: 'replace'`). */
  fallback?: Href;
  /**
   * `'back'` (default): pop the stack, falling back to `fallback` when there
   * is no history. `'replace'`: always replace with `fallback` — used by
   * deep-linkable screens that should land on a specific parent.
   */
  mode?: 'back' | 'replace';
}

/**
 * Screen-level permission guard for deep-linkable screens.
 *
 * Once `ready` is true (user + data loaded) and `allowed` is false, shows an
 * error toast and leaves the screen. Fires at most once per mount.
 *
 * Returns `true` only when the screen may render its real content; callers
 * show a spinner (or nothing) while it is false so gated controls never flash.
 */
export function useAccessGuard(
  ready: boolean,
  allowed: boolean,
  message: string,
  options: AccessGuardOptions = {}
): boolean {
  const { fallback = '/(tabs)/home', mode = 'back' } = options;
  const router = useRouter();
  const { showToast } = useToast();
  const bounced = useRef(false);

  useEffect(() => {
    if (!ready || allowed || bounced.current) return;
    bounced.current = true;
    showToast(message, 'error');
    if (mode === 'back' && router.canGoBack()) {
      router.back();
    } else {
      router.replace(fallback);
    }
  }, [ready, allowed, message, fallback, mode, router, showToast]);

  return ready && allowed;
}
