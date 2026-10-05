#!/usr/bin/env node
// Fails when any consumer of the named packages resolves, in package-lock.json, to a version in a
// different major from the range it declares. A version above the declared range but inside its
// major is a security floor (e.g. eas-cli's exact minimatch 5.1.2 raised to 5.1.9) and is listed,
// not failed. An `overrides` entry hides that mismatch from `npm ls` (it prints
// "overridden", never "invalid"), so a root override that drags a newer major down only shows up
// as a runtime TypeError later (#779). Run from a package directory after `npm install`:
//   node ../.github/scripts/check-override-ranges.mjs minimatch brace-expansion
// Rules: docs/automation/daily-upgrade-scan.md, "Override shape".
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const names = process.argv.slice(2);
if (names.length === 0) {
  process.stderr.write('usage: check-override-ranges.mjs <package> [<package> ...]\n');
  process.exit(2);
}
const semver = createRequire(join(process.cwd(), 'package.json'))('semver');
const { packages } = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));

// Node's lookup: <consumer>/node_modules/<name>, then each ancestor's node_modules, then the root.
function resolve(consumer, name) {
  let dir = consumer;
  for (;;) {
    const candidate = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return packages[candidate];
    if (!dir) return undefined;
    const cut = dir.lastIndexOf('/node_modules/');
    dir = cut < 0 ? '' : dir.slice(0, cut);
  }
}

let mismatches = 0;
let floors = 0;
for (const [path, entry] of Object.entries(packages)) {
  if (entry.link) continue;
  const declared = { ...entry.dependencies, ...entry.optionalDependencies };
  for (const name of names) {
    const range = declared[name];
    if (!range || !semver.validRange(range)) continue;
    const resolved = resolve(path, name);
    if (!resolved && entry.optionalDependencies?.[name]) continue;
    if (resolved && semver.satisfies(resolved.version, range)) continue;
    if (resolved && semver.intersects(range, `${semver.major(resolved.version)}.x`)) {
      floors += 1;
      process.stdout.write(
        `floor    ${path || '(root)'} declares ${name}@${range}, gets ${resolved.version} (same major)\n`,
      );
      continue;
    }
    mismatches += 1;
    process.stdout.write(
      `MISMATCH ${path || '(root)'} declares ${name}@${range} but gets ${resolved?.version ?? 'nothing'}\n`,
    );
  }
}
process.stdout.write(
  `${mismatches} cross-major mismatch(es), ${floors} same-major floor(s) for ${names.join(', ')}\n`,
);
process.exit(mismatches ? 1 : 0);
