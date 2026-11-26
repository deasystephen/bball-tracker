/**
 * The scroll view every form uses: a tap that is not on a text input
 * dismisses the keyboard (#1118).
 *
 * The tap handling is `KeyboardDismissView` (raw touch events, not the
 * responder system and not React Native's own tap-to-dismiss; the reasons are
 * in that file). A tap on a button or a pill dismisses the keyboard and still
 * presses the control: `handled` mode stays on, so the press is never
 * swallowed. A drag scrolls and dismisses nothing; a tap on a text input
 * moves the focus or the cursor.
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

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { ScrollViewProps } from 'react-native';
import { KeyboardDismissView, TAP_SLOP } from './KeyboardDismissView';

export { TAP_SLOP };

export type FormScrollViewProps = Omit<
  ScrollViewProps,
  'keyboardShouldPersistTaps' | 'horizontal' | 'stickyHeaderIndices'
> & {
  ref?: React.Ref<React.ComponentRef<typeof ScrollView>>;
};

export function FormScrollView({ children, contentContainerStyle, ref, ...rest }: FormScrollViewProps) {
  return (
    <ScrollView
      {...rest}
      ref={ref}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.fill}
    >
      <KeyboardDismissView style={styles.fill} testID="form-scroll-tap-area">
        <View style={contentContainerStyle} testID="form-scroll-content">
          {children}
        </View>
      </KeyboardDismissView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flexGrow: 1,
  },
});
