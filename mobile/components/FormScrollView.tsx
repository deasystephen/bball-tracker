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
 * does not dismiss. The wrapper is a plain `View`, not a pressable: it is
 * invisible to VoiceOver and to the nested-pressable guard.
 *
 * `contentContainerStyle` is applied to that wrapper, so the padding is part
 * of the tappable area and the children lay out as they did directly inside
 * the ScrollView. `__tests__/components/form-scroll-view-guard.test.ts` fails
 * on a raw `<ScrollView keyboardShouldPersistTaps="handled">` under `app/`.
 */

import React from 'react';
import { Keyboard, ScrollView, StyleSheet, View } from 'react-native';
import type { ScrollViewProps } from 'react-native';

export type FormScrollViewProps = Omit<ScrollViewProps, 'keyboardShouldPersistTaps'> & {
  ref?: React.Ref<React.ComponentRef<typeof ScrollView>>;
};

const claimUnhandledTap = () => true;
const dismissKeyboard = () => Keyboard.dismiss();

export function FormScrollView({ children, contentContainerStyle, ref, ...rest }: FormScrollViewProps) {
  return (
    <ScrollView
      {...rest}
      ref={ref}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.grow}
    >
      <View
        style={[styles.grow, contentContainerStyle]}
        onStartShouldSetResponder={claimUnhandledTap}
        onResponderRelease={dismissKeyboard}
        testID="form-scroll-content"
      >
        {children}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  grow: {
    flexGrow: 1,
  },
});
