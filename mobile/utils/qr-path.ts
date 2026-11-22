/**
 * A QR code as one SVG path (#210, the team join link).
 *
 * `qrcode-generator` is plain JavaScript with no native code, so it ships by
 * OTA; `react-native-svg`, which draws the path, is already in the binary.
 * The code is computed here and drawn as a single `<Path>` of horizontal runs
 * (a 37×37 code is a few hundred runs, never one element per module).
 */

import createQrCode from 'qrcode-generator';

/** Modules of white margin on every side; the QR specification asks for four. */
export const QR_QUIET_ZONE = 4;

export interface QrPath {
  /** Side of the square in modules, quiet zone included: the SVG `viewBox`. */
  size: number;
  /** `M x y h w v 1 h -w z` per run of dark modules, in module units. */
  path: string;
}

/**
 * Error correction M (15 %): the code is shown on a phone screen held up to
 * another phone, so a dense, low-redundancy code is the wrong trade.
 */
export function qrPath(text: string): QrPath {
  const code = createQrCode(0, 'M');
  code.addData(text);
  code.make();
  const count = code.getModuleCount();

  const runs: string[] = [];
  for (let row = 0; row < count; row += 1) {
    let start = -1;
    for (let col = 0; col <= count; col += 1) {
      const dark = col < count && code.isDark(row, col);
      if (dark && start === -1) {
        start = col;
      } else if (!dark && start !== -1) {
        const width = col - start;
        runs.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${width}v1h-${width}z`);
        start = -1;
      }
    }
  }

  return { size: count + QR_QUIET_ZONE * 2, path: runs.join('') };
}
