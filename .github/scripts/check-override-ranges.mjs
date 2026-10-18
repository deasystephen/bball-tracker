#!/usr/bin/env node
// Two modes, both read package-lock.json from the current package directory (backend/, web/ or
// mobile/). `semver` comes from that directory's node_modules, or from npm's own copy when the
// side has no install yet.
//
// 1. Range check (default): fails when any consumer of the named packages resolves, in the
//    lockfile, to a version in a different major from the range it declares. A version above the
//    declared range but inside its major is a security floor (e.g. eas-cli's exact minimatch 5.1.2
//    raised to 5.1.9) and is listed, not failed. An `overrides` entry hides that mismatch from
//    `npm ls` (it prints "overridden", never "invalid"), so a root override that drags a newer
//    major down only shows up as a runtime TypeError later (#779). Run after `npm install`:
//      node ../.github/scripts/check-override-ranges.mjs minimatch brace-expansion
//    A mismatch listed in accepted-overrides.json (same directory as this script, keyed by package
//    directory) prints as `accepted` and does not fail the gate, so exit status alone is the gate.
//
// 2. Override liveness (`--overrides`, no package names): prints one `live` or `DEAD` line per key
//    in package.json#overrides, nested blocks included. A key is live when some lockfile entry
//    still DECLARES the package (dependencies, optionalDependencies, peerDependencies, the root's
//    devDependencies, and `npm:` aliases resolved to the aliased name) with a spec that intersects
//    the key's range; for a nested `"<parent>": { … }` block only the parent copies and their
//    dependency graph count, at every depth. It never looks at resolved versions: a version-keyed
//    override that redirects out of its own range (the backend's `deepmerge-ts@^7` → 8.0.2) makes
//    `npm ls "<pkg>@<range>"` print `(empty)` precisely because it works, which is how the daily
//    scan once retired a security override (#919). Keys in accepted-overrides.json are reported
//    `live` whatever the tree says. Always exits 0; the daily scan reads the lines.
//      node ../.github/scripts/check-override-ranges.mjs --overrides
//
// Rules: docs/automation/daily-upgrade-scan.md, "Override shape" and "Retire dead entries".
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE =
  'usage: check-override-ranges.mjs <package> [<package> ...]\n' +
  '       check-override-ranges.mjs --overrides\n';
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const names = args.filter((a) => !a.startsWith('--'));
const liveness = flags.includes('--overrides');
if (args.length === 0 || flags.some((f) => f !== '--overrides') || (liveness && names.length > 0)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

function loadSemver() {
  try {
    return createRequire(join(process.cwd(), 'package.json'))('semver');
  } catch {
    /* no install in this directory: fall through to npm's own copy */
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, 'npm', 'package.json'))('semver');
  } catch {
    process.stderr.write('check-override-ranges.mjs: cannot load semver; run `npm install` in this package first\n');
    process.exit(2);
  }
}
const semver = loadSemver();
const { packages } = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
const side = basename(process.cwd());
const acceptFile = join(dirname(fileURLToPath(import.meta.url)), 'accepted-overrides.json');
const accepted = JSON.parse(readFileSync(acceptFile, 'utf8'))[side] ?? [];

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
// "<pkg>" | "<pkg>@<range>" | "@scope/<pkg>@<range>"
function parseKey(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? { name: key.slice(0, at), range: key.slice(at + 1) } : { name: key, range: null };
}
function nameOf(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

if (liveness) {
  const { overrides = {} } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

  // Every edge npm applies overrides to, keyed by the package the edge really points at: an
  // `npm:` alias (`"al": "npm:aliased@^2"`) counts for `aliased`. The root's devDependencies are
  // installed too; nobody else's are.
  function declared(path, entry) {
    const raw = {
      ...entry.peerDependencies,
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...(path === '' ? entry.devDependencies : undefined),
    };
    const out = {};
    for (const [dep, spec] of Object.entries(raw)) {
      if (typeof spec !== 'string') continue;
      if (spec.startsWith('npm:')) {
        const target = parseKey(spec.slice('npm:'.length));
        out[target.name] ??= target.range ?? '*';
      } else {
        out[dep] ??= spec;
      }
    }
    return out;
  }
  // A declared spec keeps the key alive when it intersects the key's range. Non-semver specs
  // (git, url, dist-tag) cannot be compared and count as live: a wrong "live" keeps a pin, a wrong
  // "dead" drops a security floor.
  function keeps(spec, range) {
    if (range === null) return true;
    if (!semver.validRange(spec) || !semver.validRange(range)) return true;
    return semver.intersects(spec, range);
  }
  function declarers(scope, { name, range }) {
    const found = [];
    for (const path of scope) {
      const spec = declared(path, packages[path])[name];
      if (spec !== undefined && keeps(spec, range)) found.push(`${path || '(root)'} declares ${name}@${spec}`);
    }
    return found;
  }
  // The parent and everything reachable from it through declared dependencies, memoised.
  const graphs = new Map();
  function graphFrom(root) {
    if (graphs.has(root)) return graphs.get(root);
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
    graphs.set(root, [...seen]);
    return graphs.get(root);
  }
  function parentCopies(scope, parent) {
    return scope.filter(
      (p) =>
        p !== '' &&
        nameOf(p) === parent.name &&
        (parent.range === null ||
          !semver.validRange(parent.range) ||
          semver.satisfies(packages[p].version, parent.range)),
    );
  }

  let live = 0;
  let dead = 0;
  function report(label, found, accept) {
    const shown = found.slice(0, 3).join('; ') + (found.length > 3 ? `; +${found.length - 3} more` : '');
    if (accept) {
      process.stdout.write(`live  ${label}  (accepted ${accept.ghsa}; ${found.length ? shown : 'no declarer found'})\n`);
      live += 1;
    } else if (found.length) {
      process.stdout.write(`live  ${label}  <- ${shown}\n`);
      live += 1;
    } else {
      process.stdout.write(`DEAD  ${label}\n`);
      dead += 1;
    }
  }
  // `scope`: the lockfile entries whose declarations count for this key (everything at the root,
  // the parent copies' dependency graph inside a nested block).
  function walk(label, key, value, scope) {
    if (typeof value === 'string') {
      report(label, declarers(scope, parseKey(key)), accepted.find((a) => a.override === key));
      return;
    }
    if (value === null || typeof value !== 'object') {
      process.stdout.write(`??    ${label}  unsupported override value ${JSON.stringify(value)}\n`);
      dead += 1;
      return;
    }
    const parent = parseKey(key);
    const parents = parentCopies(scope, parent);
    const graph = [...new Set(parents.flatMap(graphFrom))];
    for (const [childKey, childValue] of Object.entries(value)) {
      const childLabel = `${label} > "${childKey}"`;
      if (childKey === '.') {
        report(childLabel, parents.map((p) => `${p} is ${parent.name}@${packages[p].version}`));
        continue;
      }
      walk(childLabel, childKey, childValue, graph);
    }
  }

  const everyPath = Object.keys(packages).filter((p) => !packages[p].link);
  for (const [key, value] of Object.entries(overrides)) walk(`"${key}"`, key, value, everyPath);
  process.stdout.write(`${live} live, ${dead} dead override key(s)\n`);
  process.exit(0);
}

let mismatches = 0;
let acceptedCount = 0;
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
    const accept = accepted.find(
      (a) =>
        a.consumer === (path || '(root)') &&
        parseKey(a.override).name === name &&
        resolved !== undefined &&
        String(semver.major(resolved.version)) === String(a.gets),
    );
    if (accept) {
      acceptedCount += 1;
      process.stdout.write(
        `accepted ${path || '(root)'} declares ${name}@${range} but gets ${resolved.version} (${accept.ghsa}, accepted-overrides.json)\n`,
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
  `${mismatches} cross-major mismatch(es), ${acceptedCount} accepted, ${floors} same-major floor(s) for ${names.join(', ')}\n`,
);
process.exit(mismatches ? 1 : 0);
