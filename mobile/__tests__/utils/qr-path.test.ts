/**
 * `utils/qr-path.ts` (#210): the QR code of a join link as one SVG path.
 *
 * The path is checked against the library's own module matrix (every dark
 * module is covered exactly once, no light module is), and against what any
 * QR code must contain: three 7×7 finder patterns behind a 4-module quiet zone.
 */

import createQrCode from 'qrcode-generator';
import { qrPath, QR_QUIET_ZONE } from '../../utils/qr-path';

const URL = 'https://hooplings.com/join/3q2-7wEAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRo';

/** Paint the path's runs onto a grid of the given side. */
function paint(path: string, size: number): number[][] {
  const grid = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
  // The whole path is runs and nothing else.
  expect(runs.map((m) => m[0]).join('')).toBe(path);
  for (const [, x, y, w, back] of runs) {
    expect(w).toBe(back);
    for (let col = Number(x); col < Number(x) + Number(w); col += 1) {
      grid[Number(y)][col] += 1;
    }
  }
  return grid;
}

describe('qrPath', () => {
  it('draws exactly the dark modules of the code, inside a 4-module quiet zone', () => {
    const { size, path } = qrPath(URL);
    const reference = createQrCode(0, 'M');
    reference.addData(URL);
    reference.make();
    const count = reference.getModuleCount();

    expect(size).toBe(count + QR_QUIET_ZONE * 2);
    const grid = paint(path, size);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const inCode =
          row >= QR_QUIET_ZONE && row < size - QR_QUIET_ZONE && col >= QR_QUIET_ZONE && col < size - QR_QUIET_ZONE;
        const expected = inCode && reference.isDark(row - QR_QUIET_ZONE, col - QR_QUIET_ZONE) ? 1 : 0;
        expect(grid[row][col]).toBe(expected);
      }
    }
  });

  it('has the three finder patterns every scanner looks for', () => {
    const { size, path } = qrPath(URL);
    const grid = paint(path, size);
    const finder = [
      '1111111',
      '1000001',
      '1011101',
      '1011101',
      '1011101',
      '1000001',
      '1111111',
    ];
    const at = (top: number, left: number): string[] =>
      finder.map((_, r) => grid[top + r].slice(left, left + 7).join(''));
    const far = size - QR_QUIET_ZONE - 7;
    expect(at(QR_QUIET_ZONE, QR_QUIET_ZONE)).toEqual(finder);
    expect(at(QR_QUIET_ZONE, far)).toEqual(finder);
    expect(at(far, QR_QUIET_ZONE)).toEqual(finder);
  });

  it('merges neighbouring modules into runs: far fewer path segments than dark modules', () => {
    const { size, path } = qrPath(URL);
    const dark = paint(path, size).flat().filter((cell) => cell === 1).length;
    const runs = path.split('M').length - 1;
    expect(runs).toBeLessThan(dark * 0.7);
  });

  it('is deterministic, and a different link is a different code', () => {
    expect(qrPath(URL)).toEqual(qrPath(URL));
    expect(qrPath(`${URL}x`).path).not.toBe(qrPath(URL).path);
  });

  it('holds a full-length join link at a size a phone screen can show', () => {
    // 43-character token on the production host: version 5 (37 modules) at level M.
    expect(qrPath(URL).size).toBeLessThanOrEqual(41 + QR_QUIET_ZONE * 2);
  });
});
