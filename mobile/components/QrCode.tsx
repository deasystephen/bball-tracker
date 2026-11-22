/**
 * A QR code for a URL (#210, the team join link), drawn with
 * `react-native-svg` from `utils/qr-path.ts`.
 *
 * Always black on white, whatever the theme: scanners expect dark modules on
 * a light field, and a dark-mode palette would invert it. The view is one
 * image to assistive technology, labelled by the caller.
 */

import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { qrPath } from '../utils/qr-path';
import { borderRadius } from '../theme';

interface QrCodeProps {
  /** The text to encode. */
  value: string;
  /** Rendered side in points, quiet zone included. */
  size: number;
  accessibilityLabel: string;
  testID?: string;
}

const QR_DARK = '#000000';
const QR_LIGHT = '#FFFFFF';

export function QrCode({ value, size, accessibilityLabel, testID }: QrCodeProps) {
  const code = useMemo(() => qrPath(value), [value]);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[styles.frame, { width: size, height: size }]}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${code.size} ${code.size}`}>
        <Rect x={0} y={0} width={code.size} height={code.size} fill={QR_LIGHT} />
        <Path d={code.path} fill={QR_DARK} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: QR_LIGHT,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
});
