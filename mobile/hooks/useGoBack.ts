import { useCallback } from 'react';
import { useRouter, type Href } from 'expo-router';

/**
 * Leaves a pushed screen: pops the stack, or replaces with `fallback` when
 * there is nothing to pop (the screen was opened by a deep link or a
 * notification). Same rule as `useAccessGuard`.
 *
 * It is what a full-screen `ErrorState` gets as `onBack`: the error replaces
 * the screen's own header, back arrow included (#589, #595).
 */
export function useGoBack(fallback: Href = '/(tabs)/home'): () => void {
  const router = useRouter();

  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(fallback);
    }
  }, [router, fallback]);
}
