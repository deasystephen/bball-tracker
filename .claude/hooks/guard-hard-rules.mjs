#!/usr/bin/env node
// PreToolUse hook: refuse the tool calls that CLAUDE.md's hard rules forbid.
//
// Prose rules hold while somebody is watching. An unattended run has nobody,
// so the rules that must never be broken are refused here, before the tool
// runs. What is enforced where: docs/automation/claude-code-sessions.md.
//
// Input: the hook JSON on stdin ({ tool_name, tool_input, cwd }).
// Output: nothing (allow), or a PreToolUse decision of "deny" or "ask" with
// the rule as the reason. Any error inside this script allows the call: a
// broken guard must not stop every session, and CI backstops the rules that
// matter most (migrations, lint suppressions, the binary manifest).
//
// Tested by mobile/__tests__/repo/claude-hooks.test.ts, which runs this file
// as a process, the way the harness does.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Files that may carry an `eslint-disable` (CLAUDE.md, Code Style). */
const ESLINT_DISABLE_ALLOWED = [
  'backend/src/api/auth/middleware.ts',
  'backend/src/api/middleware/request-context.ts',
];

const RULES = {
  gitReset:
    'CLAUDE.md, Work Hygiene: never `git reset`. Several sessions share this checkout. To unstage, use `git restore --staged <file>`; to work apart, use a sibling `git worktree`.',
  gitStash:
    'CLAUDE.md, Work Hygiene: never `git stash`. Several sessions share this checkout and a stash takes their changes too. Use a sibling `git worktree`.',
  gitCheckoutPaths:
    'CLAUDE.md, Work Hygiene: never `git checkout -- <path>` (or `git checkout .`). It discards uncommitted work, which may belong to another session.',
  forcePush:
    'CLAUDE.md, Work Hygiene: a force-push needs the owner\'s OK first (several sessions share these branches).',
  pkill:
    'Stop only what you started: kill by PID, never `pkill` or `killall` by name. The owner runs other sessions on this machine.',
  expoStart:
    'CLAUDE.md, Mobile commands: never `npm start` or `expo start` in mobile/. Native modules need the build that `npx expo run:ios` makes.',
  unsigned:
    'CLAUDE.md, Mobile commands: never build with CODE_SIGNING_ALLOWED=NO. An unsigned build has no entitlements, so the keychain refuses every call and session tokens are never stored.',
  binaryManifest:
    'CLAUDE.md, Mobile builds and OTA: never edit mobile/binary-manifest.json by hand. Record a build with `BINARY_BUILD=<n> BINARY_COMMIT=<sha> npm run binary-manifest:record`.',
  mergedMigration:
    'CLAUDE.md, Data and invariants: never edit or remove a migration that is already on `main`. It has run in production. Add a new migration.',
  eslintDisable:
    'CLAUDE.md, Code Style: never suppress a lint error with `eslint-disable`. Fix the code.',
};

const deny = (rule) => ({ decision: 'deny', reason: RULES[rule] });
const ask = (rule) => ({ decision: 'ask', reason: RULES[rule] });

// ---------------------------------------------------------------------------
// Shell parsing. Enough of a tokenizer to tell a command from a string that
// mentions one: `git commit -m "never git stash"` and `grep 'git reset'` are
// arguments, `a && git stash` and `(git stash)` are commands.
// ---------------------------------------------------------------------------

/** Drop here-document bodies; they are data (an issue body, a commit message). */
function stripHeredocs(command) {
  const lines = command.split('\n');
  const kept = [];
  let terminator = null;
  let stripTabs = false;
  for (const line of lines) {
    if (terminator !== null) {
      const candidate = stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const match = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (match) {
      stripTabs = match[1] === '-';
      terminator = match[3];
    }
  }
  return kept.join('\n');
}

/**
 * Split a command line into segments (one simple command each), each a list
 * of words with quotes resolved. `nested` collects command substitutions
 * found inside double quotes or backticks, to be checked on their own.
 */
function parse(command) {
  const segments = [];
  const nested = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  const text = stripHeredocs(command);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      if (text[i + 1] === '\n') {
        i += 1;
        continue;
      }
      word += text[i + 1] ?? '';
      inWord = true;
      i += 1;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (ch === '"') {
      let quoted = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j += 1) {
        if (text[j] === '\\' && j + 1 < text.length) {
          quoted += text[j + 1];
          j += 1;
        } else {
          quoted += text[j];
        }
      }
      for (const sub of quoted.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) nested.push(sub[1] ?? sub[2]);
      word += quoted;
      inWord = true;
      i = j;
    } else if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      const stop = end === -1 ? text.length : end;
      nested.push(text.slice(i + 1, stop));
      inWord = true;
      i = stop;
    } else if (ch === '#' && !inWord) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
    } else if (ch === '>' || ch === '<') {
      endWord();
      words.push(ch);
      if (text[i + 1] === ch) i += 1;
    } else if (';&|\n()'.includes(ch)) {
      endSegment();
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endSegment();
  return { segments, nested };
}

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env', 'caffeinate']);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const READ_ONLY = new Set(['grep', 'rg', 'echo', 'printf', 'cat', 'git', 'gh', 'ls', 'find']);

function isInMobile(dir) {
  return path.resolve(dir).split(path.sep).includes('mobile');
}

/** Words after `xargs` and its flags: the command it will run. */
function afterXargs(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += 1;
  return words.slice(i);
}

function checkSegment(allWords, state) {
  let words = allWords;
  const assigns = [];
  for (;;) {
    if (words.length === 0) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      assigns.push(words[0]);
      words = words.slice(1);
    } else if (WRAPPERS.has(path.basename(words[0]))) {
      words = words.slice(1);
      while (words.length > 0 && words[0].startsWith('-')) words = words.slice(1);
    } else if (words[0] === '{' || words[0] === '!' || words[0] === 'then' || words[0] === 'do' || words[0] === 'else') {
      words = words.slice(1);
    } else if (path.basename(words[0]) === 'xargs') {
      words = afterXargs(words);
    } else {
      break;
    }
  }
  if (words.length === 0) return null;
  const cmd = path.basename(words[0]);
  const args = words.slice(1);

  if (cmd === 'cd' && args[0] && !args[0].startsWith('-')) {
    state.dir = path.resolve(state.dir, args[0].replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    return null;
  }

  if (SHELLS.has(cmd) || cmd === 'eval') {
    const script = cmd === 'eval' ? args.join(' ') : args[args.findIndex((a) => /^-[a-z]*c$/.test(a)) + 1];
    const hasScript = cmd === 'eval' || args.some((a) => /^-[a-z]*c$/.test(a));
    return hasScript && script ? checkCommand(script, state) : null;
  }

  if (cmd === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C' && args[i + 1]) state.dir = path.resolve(state.dir, args[i + 1]);
      i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (sub === 'reset') return deny('gitReset');
    if (sub === 'stash' && rest[0] !== 'list' && rest[0] !== 'show') return deny('gitStash');
    if (sub === 'checkout' && (rest.includes('--') || rest.includes('.'))) return deny('gitCheckoutPaths');
    if (
      sub === 'push' &&
      rest.some(
        (a) => a === '-f' || a === '--force' || a.startsWith('--force-') || /^-[a-eg-z]*f[a-z]*$/.test(a) || a.startsWith('+'),
      )
    ) {
      return ask('forcePush');
    }
  }

  if (cmd === 'pkill' || cmd === 'killall') return deny('pkill');

  if (cmd === 'npm') {
    let dir = state.dir;
    const positional = [];
    for (let i = 0; i < args.length; i += 1) {
      if ((args[i] === '--prefix' || args[i] === '-C') && args[i + 1]) {
        dir = path.resolve(state.dir, args[i + 1]);
        i += 1;
      } else if (args[i].startsWith('--prefix=')) {
        dir = path.resolve(state.dir, args[i].slice('--prefix='.length));
      } else if (!args[i].startsWith('-')) {
        positional.push(args[i]);
      }
    }
    const isStart = positional[0] === 'start' || (positional[0] === 'run' && positional[1] === 'start');
    if (isStart && isInMobile(dir)) return deny('expoStart');
  }

  if (cmd === 'npx' || cmd === 'expo') {
    const positional = args.filter((a) => !a.startsWith('-'));
    const afterExpo = cmd === 'expo' ? positional : positional[0] === 'expo' ? positional.slice(1) : null;
    if (afterExpo && afterExpo[0] === 'start') return deny('expoStart');
  }

  if (!READ_ONLY.has(cmd) && [...assigns, ...args].some((w) => /^CODE_SIGNING_ALLOWED=NO$/i.test(w))) {
    return deny('unsigned');
  }

  const manifestAt = allWords.findIndex((w) => /(^|\/)binary-manifest\.json$/.test(w));
  if (manifestAt !== -1) {
    const redirected = allWords[manifestAt - 1] === '>';
    const inPlace =
      (cmd === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) ||
      (cmd === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a)));
    if (redirected || inPlace || ['tee', 'rm', 'mv', 'cp', 'truncate'].includes(cmd)) return deny('binaryManifest');
  }

  return null;
}

function checkCommand(command, state) {
  const { segments, nested } = parse(command);
  for (const words of segments) {
    const verdict = checkSegment(words, state);
    if (verdict) return verdict;
  }
  for (const inner of nested) {
    const verdict = checkCommand(inner, { ...state });
    if (verdict) return verdict;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File edits.
// ---------------------------------------------------------------------------

function repoRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Whether `relPath` exists on main (origin's, else the local branch). */
function isOnMain(root, relPath) {
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
    } catch {
      continue;
    }
    try {
      execFileSync('git', ['-C', root, 'cat-file', '-e', `${ref}:${relPath}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function checkEdit(toolInput, cwd) {
  const filePath = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof filePath !== 'string') return null;
  const absolute = path.resolve(cwd, filePath);
  const root = repoRoot(path.dirname(absolute)) ?? repoRoot(cwd);
  const rel = root ? path.relative(root, absolute).split(path.sep).join('/') : absolute;

  if (rel === 'mobile/binary-manifest.json') return deny('binaryManifest');

  if (root && rel.startsWith('backend/prisma/migrations/') && isOnMain(root, rel)) {
    return deny('mergedMigration');
  }

  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel) && !ESLINT_DISABLE_ALLOWED.includes(rel)) {
    const added = [toolInput.new_string, toolInput.content, toolInput.new_source]
      .filter((v) => typeof v === 'string')
      .join('\n');
    const removed = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
    const directive = /(\/\/|\/\*)\s*eslint-disable/;
    if (directive.test(added) && !directive.test(removed)) return deny('eslintDisable');
  }

  return null;
}

// ---------------------------------------------------------------------------

function decide(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const toolInput = input.tool_input ?? {};
  if (input.tool_name === 'Bash') {
    return typeof toolInput.command === 'string' ? checkCommand(toolInput.command, { dir: cwd }) : null;
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
    return checkEdit(toolInput, cwd);
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let verdict = null;
  try {
    verdict = decide(JSON.parse(raw));
  } catch {
    verdict = null;
  }
  if (verdict) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict.decision,
          permissionDecisionReason: verdict.reason,
        },
      }),
    );
  }
  process.exit(0);
});
