/**
 * Tells `FormScrollView` that the touch now starting began on a text input
 * (#1118). Touch events bubble from the touched view upwards, so `Input`
 * marks the touch before the scroll view's wrapper sees it. React Native has
 * no public way to ask whether a touch target is a text input.
 */

const FRESH_MS = 250;

let markedAt = 0;

/** Called by `Input` from `onTouchStart`. */
export function markTextInputTouch(): void {
  markedAt = Date.now();
}

/** True once per marked touch, and only while the mark is fresh. */
export function takeTextInputTouch(): boolean {
  const fresh = markedAt !== 0 && Date.now() - markedAt <= FRESH_MS;
  markedAt = 0;
  return fresh;
}
