// Regenerates the production icon PNGs in mobile/assets/ from the SVG masters
// in this directory. Run from mobile/: `node assets/brand/render-icons.mjs`
// (@resvg/resvg-js is a devDependency). Icons are baked into the native binary,
// so changes here ship with the next `eas build`, not an OTA.
import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '..');

const jobs = [
  { src: 'icon.svg', out: 'icon.png', size: 1024 },
  { src: 'adaptive-icon.svg', out: 'adaptive-icon.png', size: 1024 },
  { src: 'capy-sticker.svg', out: 'splash-icon.png', size: 1024 },
  { src: 'icon.svg', out: 'favicon.png', size: 48 },
];

for (const { src, out, size } of jobs) {
  const svg = await readFile(path.join(here, src), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(path.join(assets, out), png);
  console.log(`${out} ${size}x${size} ${png.length} bytes`);
}
