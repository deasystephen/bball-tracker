/**
 * The scroll view every form uses: a tap on anything that does not handle the
 * touch itself (a label, a card, empty space) dismisses the keyboard.
 *
 * React Native's own tap-to-dismiss (`keyboardShouldPersistTaps="handled"`)
 * only fires while the ScrollView believes a keyboard is open, which it tracks
 * from the system's show and hide notifications. iOS 27 posts a hide while the
 * keyboard is still on screen (the frame changes from 328pt to 270pt and the
 * event is reported as a hide), so from then on the ScrollView ignores the tap
 * and the keyboard stays over the submit button (#1118).
 *
 * This component does not ask whether a keyboard is open. The content wrapper
 * becomes the touch responder for any tap no child claims, and blurs the
 * focused input on release. Buttons, pills and inputs sit deeper in the tree
 * and claim their touches first; a drag is taken over by the native scroll
 * view, which ends the gesture as a terminate, never a release, so scrolling
 * does not dismiss. Where nothing takes the drag over (a form too short to
 * scroll), a release further than TAP_SLOP from where the touch began is not
 * a tap and dismisses nothing either. The wrapper is a plain `View`, not a
 * pressable: it is invisible to VoiceOver and to the nested-pressable guard.
 *
 * Two views, on purpose. The outer one fills the viewport so a tap below a
 * short form still dismisses. The inner one takes `contentContainerStyle` and
 * is as tall as its content unless the caller's style says otherwise, exactly
 * like a ScrollView's own content container: `Card` is `flex: 1`, and inside
 * a stretched parent the cards would share the leftover height instead of
 * sizing to their content. `horizontal` and `stickyHeaderIndices` are not
 * accepted: both address the ScrollView's direct children, which are now the
 * wrapper. `__tests__/components/form-scroll-view-guard.test.ts` fails
 * on a raw `<ScrollView keyboardShouldPersistTaps="handled">` under `app/`.
 */

import React, { useRef } from 'react';
import { Keyboard, ScrollView, StyleSheet, View } from 'react-native';
import type { GestureResponderEvent, ScrollViewProps } from 'react-native';

export type FormScrollViewProps = Omit<
  ScrollViewProps,
  'keyboardShouldPersistTaps' | 'horizontal' | 'stickyHeaderIndices'
> & {
  ref?: React.Ref<React.ComponentRef<typeof ScrollView>>;
};

/** How far a touch may travel, in points, and still count as a tap. */
export const TAP_SLOP = 10;

const claimUnhandledTap = () => true;

export function FormScrollView({ children, contentContainerStyle, ref, ...rest }: FormScrollViewProps) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const rememberStart = (event: GestureResponderEvent) => {
    touchStart.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
  };

  const dismissOnTap = (event: GestureResponderEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const { pageX, pageY } = event.nativeEvent;
    if (Math.abs(pageX - start.x) > TAP_SLOP || Math.abs(pageY - start.y) > TAP_SLOP) return;
    Keyboard.dismiss();
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
        onStartShouldSetResponder={claimUnhandledTap}
        onResponderGrant={rememberStart}
        onResponderRelease={dismissOnTap}
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
