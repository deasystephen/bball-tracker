/**
 * Tells `FormScrollView` that the touch now starting began on a text input
 * (#1118). Touch events bubble from the touched view upwards, so `Input`
 * marks the touch before the scroll view's wrapper sees the same event.
 * React Native has no public way to ask whether a touch target is a text
 * input.
 *
 * The mark is the native event's own timestamp, so it can only match the one
 * event it was taken from: an `Input` outside any `FormScrollView` leaves a
 * mark that no later touch can pick up.
 */

import type { GestureResponderEvent } from 'react-native';

let markedTimestamp: number | null = null;

/** Called by `Input` from `onTouchStart`. */
export function markTextInputTouch(event: GestureResponderEvent): void {
  markedTimestamp = event.nativeEvent.timestamp;
}

/** True when this is the event an `Input` just marked. */
export function isTextInputTouch(event: GestureResponderEvent): boolean {
  const marked = markedTimestamp !== null && markedTimestamp === event.nativeEvent.timestamp;
  markedTimestamp = null;
  return marked;
}
