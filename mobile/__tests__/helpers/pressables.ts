/**
 * What the pressable guards scan, in one place (#655 review): the
 * nested-pressables, pressable-roles and touch-targets guards all read the
 * same files and agree on what React Native's own touchables are. Not a test
 * file (Jest only collects `*.test.ts(x)`).
 */

import path from 'path';

import { MOBILE_ROOT, readSource, sourceFiles } from './source-files';

/** Where app code with pressables lives, relative to `mobile/`. */
export const SCANNED_DIRS = ['app', 'components'] as const;

/**
 * React Native's touchables. Every guard treats all four the same way; a
 * component that renders one of them goes in the guard's own wider set
 * (nested-pressables' `ALWAYS_PRESSABLE`), never in this one.
 */
export const TOUCHABLES: ReadonlySet<string> = new Set([
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'Pressable',
]);

/** Icon components: their glyph means nothing to a screen reader, and their `size` sets an icon button's. */
export const ICONS: ReadonlySet<string> = new Set([
  'Ionicons',
  'MaterialIcons',
  'MaterialCommunityIcons',
  'FontAwesome',
  'Feather',
]);

/** Fewer files than this means the scan went wrong, not that the app shrank. */
const MIN_SCANNED_FILES = 50;

export interface ScannedSource {
  /** Path relative to `mobile/` (what findings report). */
  file: string;
  text: string;
}

/**
 * Every `.tsx` under `SCANNED_DIRS`. Throws when it finds suspiciously few,
 * so a guard never passes for the wrong reason by scanning nothing.
 */
export function scannedSources(): ScannedSource[] {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.tsx']));
  if (files.length < MIN_SCANNED_FILES) {
    throw new Error(`pressable guards scanned only ${files.length} files under ${SCANNED_DIRS.join(', ')}`);
  }
  return files.map((absolute) => {
    const file = path.relative(MOBILE_ROOT, absolute);
    return { file, text: readSource(file) };
  });
}
