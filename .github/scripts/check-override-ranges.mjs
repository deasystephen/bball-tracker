#!/usr/bin/env node
// Two modes, both read package-lock.json from the current package directory.
//
// 1. Range check (default): fails when any consumer of the named packages resolves, in the
//    lockfile, to a version in a different major from the range it declares. A version above the
//    declared range but inside its major is a security floor (e.g. eas-cli's exact minimatch 5.1.2
//    raised to 5.1.9) and is listed, not failed. An `overrides` entry hides that mismatch from
//    `npm ls` (it prints "overridden", never "invalid"), so a root override that drags a newer
//    major down only shows up as a runtime TypeError later (#779). Run after `npm install`:
//      node ../.github/scripts/check-override-ranges.mjs minimatch brace-expansion
//
// 2. Override liveness (`--overrides`): prints one `live` or `DEAD` line per key in
//    package.json#overrides. A key is live when some lockfile entry still DECLARES the package with
//    a spec that intersects the key's range (any spec for a bare key; for a nested
//    `"<parent>": { … }` block only the parent and its dependency graph count). It never looks at
//    resolved versions: a version-keyed override that redirects out of its own range (the
//    backend's `deepmerge-ts@^7` → 8.0.2) makes `npm ls "<pkg>@<range>"` print `(empty)` precisely
//    because it works, which is how the daily scan once retired a security override (#919).
//      node ../.github/scripts/check-override-ranges.mjs --overrides
//    Always exits 0; the daily scan reads the lines.
//
// Rules: docs/automation/daily-upgrade-scan.md, "Override shape" and "Retire dead entries".
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write(
    'usage: check-override-ranges.mjs <package> [<package> ...]\n       check-override-ranges.mjs --overrides\n',
  );
  process.exit(2);
}
const semver = createRequire(join(process.cwd(), 'package.json'))('semver');
const { packages } = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));

// Node's lookup: <consumer>/node_modules/<name>, then each ancestor's node_modules, then the root.
function resolvePath(consumer, name) {
  let dir = consumer;
  for (;;) {
    const candidate = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!dir) return undefined;
    const cut = dir.lastIndexOf('/node_modules/');
    dir = cut < 0 ? '' : dir.slice(0, cut);
  }
}
function resolve(consumer, name) {
  const path = resolvePath(consumer, name);
  return path === undefined ? undefined : packages[path];
}

// What an entry declares (what an override key is matched against). The root entry's
// devDependencies are installed too; nobody else's are.
function declared(path, entry) {
  return {
    ...entry.dependencies,
    ...entry.optionalDependencies,
    ...(path === '' ? entry.devDependencies : undefined),
  };
}

if (args[0] === '--overrides') {
  const { overrides = {} } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

  // "<pkg>" | "<pkg>@<range>" | "@scope/<pkg>@<range>"
  function parseKey(key) {
    const at = key.lastIndexOf('@');
    return at > 0 ? { name: key.slice(0, at), range: key.slice(at + 1) } : { name: key, range: null };
  }
  function nameOf(path) {
    return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  }
  // A declared spec keeps the key alive when it intersects the key's range. Non-semver specs
  // (git, url, dist-tag) cannot be compared and count as live: a wrong "live" keeps a pin, a wrong
  // "dead" drops a security floor.
  function keeps(spec, range) {
    if (range === null) return true;
    if (!semver.validRange(spec) || !semver.validRange(range)) return true;
    return semver.intersects(spec, range);
  }
  function declarers(paths, { name, range }) {
    const found = [];
    for (const path of paths) {
      const spec = declared(path, packages[path])[name];
      if (spec !== undefined && keeps(spec, range)) found.push(`${path || '(root)'} declares ${name}@${spec}`);
    }
    return found;
  }
  // The parent and everything reachable from it through declared dependencies.
  function graphFrom(root) {
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
      const path = queue.shift();
      for (const dep of Object.keys(declared(path, packages[path]))) {
        const next = resolvePath(path, dep);
        if (next !== undefined && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return [...seen];
  }
  function report(label, found) {
    const shown = found.slice(0, 3).join('; ') + (found.length > 3 ? `; +${found.length - 3} more` : '');
    process.stdout.write(found.length ? `live  ${label}  <- ${shown}\n` : `DEAD  ${label}\n`);
    return found.length > 0;
  }

  const everyPath = Object.keys(packages).filter((p) => !packages[p].link);
  let live = 0;
  let dead = 0;
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      report(`"${key}"`, declarers(everyPath, parseKey(key))) ? live++ : dead++;
      continue;
    }
    const parent = parseKey(key);
    const parents = everyPath.filter(
      (p) =>
        p !== '' &&
        nameOf(p) === parent.name &&
        (parent.range === null || semver.satisfies(packages[p].version, parent.range)),
    );
    for (const childKey of Object.keys(value)) {
      const label = `"${key}": { "${childKey}" }`;
      if (childKey === '.') {
        report(label, parents.map((p) => `${p} is ${parent.name}@${packages[p].version}`)) ? live++ : dead++;
        continue;
      }
      const found = [...new Set(parents.flatMap((p) => declarers(graphFrom(p), parseKey(childKey))))];
      report(label, found) ? live++ : dead++;
    }
  }
  process.stdout.write(`${live} live, ${dead} dead override key(s)\n`);
  process.exit(0);
}

const names = args;
let mismatches = 0;
let floors = 0;
for (const [path, entry] of Object.entries(packages)) {
  if (entry.link) continue;
  const declaredHere = { ...entry.dependencies, ...entry.optionalDependencies };
  for (const name of names) {
    const range = declaredHere[name];
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
