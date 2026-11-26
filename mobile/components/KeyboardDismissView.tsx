/**
 * A view in which a tap that is not on a text input dismisses the keyboard
 * (#1118, #1122). `FormScrollView` is built on it; a screen whose inputs sit
 * beside a `FlatList` or `SectionList` (a composer above or below a list)
 * wraps the list and the inputs in it directly.
 *
 * It listens to the raw touch events (`onTouchStart` / `onTouchMove` /
 * `onTouchEnd` / `onTouchCancel`), which reach this view whoever ends up as
 * the JS touch responder. It deliberately does not use the responder system
 * and does not rely on React Native's own tap-to-dismiss
 * (`keyboardShouldPersistTaps="handled"`): on an iPhone on iOS 27.2 both left
 * the keyboard up after a finger tap on a label, while buttons on the same
 * form took their taps and `Keyboard.dismiss()` from a button worked.
 *
 * A tap is a touch that ends within TAP_SLOP of where it began. A drag
 * travels further or is cancelled when a scroll view takes it over, so
 * scrolling dismisses nothing. A tap on a button, a pill or a list row
 * dismisses the keyboard (the focused field loses the focus, also with a
 * hardware keyboard) and still presses the control, provided every scroll
 * view inside is in `keyboardShouldPersistTaps="handled"` mode, which keeps
 * the press from being swallowed. A tap on a text input is left alone: it
 * moves the focus or the cursor (`Input` marks such a touch through
 * `utils/text-input-touch.ts`).
 *
 * Not a pressable: nothing for VoiceOver, nothing for the nested-pressable
 * guard.
 */

import React, { useRef } from 'react';
import { Keyboard, TextInput, View } from 'react-native';
import type { GestureResponderEvent, ViewProps } from 'react-native';
import { isTextInputTouch } from '../utils/text-input-touch';

export type KeyboardDismissViewProps = Omit<
  ViewProps,
  'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel'
>;

/** How far a touch may travel, in points, and still count as a tap. */
export const TAP_SLOP = 10;

interface Touch {
  x: number;
  y: number;
  travel: number;
}

export function KeyboardDismissView({ children, ...rest }: KeyboardDismissViewProps) {
  const touch = useRef<Touch | null>(null);

  const begin = (event: GestureResponderEvent) => {
    // A touch on a field moves the focus or the cursor; a second finger is no tap.
    if (isTextInputTouch(event) || event.nativeEvent.touches.length > 1) {
      touch.current = null;
      return;
    }
    touch.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, travel: 0 };
  };

  const track = (event: GestureResponderEvent) => {
    const current = touch.current;
    if (!current) return;
    const { pageX, pageY } = event.nativeEvent;
    current.travel = Math.max(current.travel, Math.abs(pageX - current.x), Math.abs(pageY - current.y));
  };

  const end = (event: GestureResponderEvent) => {
    const current = touch.current;
    touch.current = null;
    if (!current) return;
    const { pageX, pageY } = event.nativeEvent;
    const travel = Math.max(current.travel, Math.abs(pageX - current.x), Math.abs(pageY - current.y));
    if (travel > TAP_SLOP) return;
    if (!TextInput.State.currentlyFocusedInput()) return;
    Keyboard.dismiss();
  };

  // A cancelled touch is the system or a scroll view taking the gesture
  // over (a scroll or a swipe back can begin inside TAP_SLOP): no tap.
  const cancel = () => {
    touch.current = null;
  };

  return (
    <View {...rest} onTouchStart={begin} onTouchMove={track} onTouchEnd={end} onTouchCancel={cancel}>
      {children}
    </View>
  );
}
