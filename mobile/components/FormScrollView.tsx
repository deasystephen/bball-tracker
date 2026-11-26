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
 * A tap is a touch that ends, or is cancelled, within TAP_SLOP of where it
 * began. A drag travels further, so scrolling dismisses nothing. A tap on a
 * button or a pill dismisses the keyboard and still presses the control
 * (`handled` mode stays on, so the press is never swallowed). A tap on a text
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
 *
 * TEMPORARY (#1118): if the keyboard is still up after a tap that should have
 * dismissed it, one Sentry event per app session reports what the touch did
 * (phases, distance, focus before and after; no text, no ids). Remove
 * `reportIfKeyboardStuck` once the device check passes.
 */

import React, { useEffect, useRef } from 'react';
import { Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import type { GestureResponderEvent, ScrollViewProps } from 'react-native';
import { captureException } from '../services/sentry';
import { takeTextInputTouch } from '../utils/text-input-touch';

export type FormScrollViewProps = Omit<
  ScrollViewProps,
  'keyboardShouldPersistTaps' | 'horizontal' | 'stickyHeaderIndices'
> & {
  ref?: React.Ref<React.ComponentRef<typeof ScrollView>>;
};

/** How far a touch may travel, in points, and still count as a tap. */
export const TAP_SLOP = 10;
/** How long after a tap the keyboard is checked (TEMPORARY, #1118). */
export const STUCK_CHECK_MS = 700;

interface Touch {
  x: number;
  y: number;
  travel: number;
}

let stuckKeyboardReported = false;

/** Test hook: the report is sent once per app session. */
export function resetStuckKeyboardReport(): void {
  stuckKeyboardReported = false;
}

export function FormScrollView({ children, contentContainerStyle, ref, ...rest }: FormScrollViewProps) {
  const touch = useRef<Touch | null>(null);
  const stuckCheck = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (stuckCheck.current) clearTimeout(stuckCheck.current);
    },
    []
  );

  const begin = (event: GestureResponderEvent) => {
    const onTextInput = takeTextInputTouch();
    if (onTextInput || event.nativeEvent.touches.length > 1) {
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

  const finish = (phase: 'end' | 'cancel', event: GestureResponderEvent) => {
    const current = touch.current;
    touch.current = null;
    if (!current) return;
    const { pageX, pageY } = event.nativeEvent;
    const travel = Math.max(current.travel, Math.abs(pageX - current.x), Math.abs(pageY - current.y));
    if (travel > TAP_SLOP) return;

    const focused = TextInput.State.currentlyFocusedInput();
    if (!focused) return;

    Keyboard.dismiss();

    // TEMPORARY (#1118), see reportIfKeyboardStuck.
    const focusedRightAfter = TextInput.State.currentlyFocusedInput() != null;
    if (stuckCheck.current) clearTimeout(stuckCheck.current);
    stuckCheck.current = setTimeout(() => {
      stuckCheck.current = null;
      reportIfKeyboardStuck({ phase, travel: Math.round(travel), focused, focusedRightAfter });
    }, STUCK_CHECK_MS);
  };
  const end = (event: GestureResponderEvent) => finish('end', event);
  const cancel = (event: GestureResponderEvent) => finish('cancel', event);

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

/**
 * TEMPORARY (#1118): tell Sentry, once per session, when a tap that called
 * `Keyboard.dismiss()` left the keyboard on screen, and whether an input was
 * focused again afterwards.
 */
function reportIfKeyboardStuck(tap: {
  phase: string;
  travel: number;
  focused: unknown;
  focusedRightAfter: boolean;
}): void {
  if (stuckKeyboardReported || !Keyboard.isVisible()) return;
  stuckKeyboardReported = true;
  const focusedLater = TextInput.State.currentlyFocusedInput();
  captureException(
    new Error('Keyboard still visible after a dismissing tap'),
    {
      flow: 'form-keyboard-dismiss',
      phase: tap.phase,
      travel: tap.travel,
      focusedRightAfterDismiss: tap.focusedRightAfter,
      focusedLater: focusedLater != null,
      sameInputFocusedLater: focusedLater != null && focusedLater === tap.focused,
    },
    { flow: 'form-keyboard-dismiss' }
  );
}

const styles = StyleSheet.create({
  fill: {
    flexGrow: 1,
  },
});
