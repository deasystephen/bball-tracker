/**
 * The scroll view every form uses: a tap that is not on a text input
 * dismisses the keyboard (#1118).
 *
 * It listens to the raw touch events (`onTouchStart` / `onTouchMove` /
 * `onTouchEnd` / `onTouchCancel`), which reach this view whoever ends up as
 * the JS touch responder. It deliberately does not use the responder system
 * and does not rely on React Native's own tap-to-dismiss
 * (`keyboardShouldPersistTaps="handled"`): on an iPhone on iOS 27.2 both left
 * the keyboard up after a finger tap on a label, while buttons on the same
 * form took their taps and `Keyboard.dismiss()` from a button worked. The
 * first version of this component claimed the responder for unhandled taps;
 * it passed on the simulator and did nothing on the device.
 *
 * A tap is a touch that ends within TAP_SLOP of where it began. A drag
 * travels further or is cancelled when the scroll view takes it over, so
 * scrolling dismisses nothing. A tap on a button or a pill dismisses the
 * keyboard (the focused field loses the focus, also with a hardware keyboard)
 * and still presses the control: `handled` mode stays on, so the press is
 * never swallowed. A tap on a text
 * input is left alone: it moves the focus or the cursor (`Input` marks such
 * a touch through `utils/text-input-touch.ts`).
 *
 * Two views, on purpose. The outer one fills the viewport so a tap below a
 * short form still dismisses. The inner one takes `contentContainerStyle` and
 * is as tall as its content unless the caller's style says otherwise, exactly
 * like a ScrollView's own content container: `Card` is `flex: 1`, and inside
 * a stretched parent the cards would share the leftover height instead of
 * sizing to their content. `horizontal` and `stickyHeaderIndices` are not
 * accepted: both address the ScrollView's direct children, which are now the
 * wrapper. `__tests__/components/form-scroll-view-guard.test.ts` fails on a
 * raw `<ScrollView>` with a text input under `app/`.
 */

import React, { useRef } from 'react';
import { Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import type { GestureResponderEvent, ScrollViewProps } from 'react-native';
import { isTextInputTouch } from '../utils/text-input-touch';

export type FormScrollViewProps = Omit<
  ScrollViewProps,
  'keyboardShouldPersistTaps' | 'horizontal' | 'stickyHeaderIndices'
> & {
  ref?: React.Ref<React.ComponentRef<typeof ScrollView>>;
};

/** How far a touch may travel, in points, and still count as a tap. */
export const TAP_SLOP = 10;
interface Touch {
  x: number;
  y: number;
  travel: number;
}

export function FormScrollView({ children, contentContainerStyle, ref, ...rest }: FormScrollViewProps) {
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

  // A cancelled touch is the system or the scroll view taking the gesture
  // over (a scroll or a swipe back can begin inside TAP_SLOP): no tap.
  const cancel = () => {
    touch.current = null;
  };

  return (
    <ScrollView
      {...rest}
      ref={ref}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.fill}
    >
      <View
        style={styles.fill}
        onTouchStart={begin}
        onTouchMove={track}
        onTouchEnd={end}
        onTouchCancel={cancel}
        testID="form-scroll-tap-area"
      >
        <View style={contentContainerStyle} testID="form-scroll-content">
          {children}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flexGrow: 1,
  },
});
