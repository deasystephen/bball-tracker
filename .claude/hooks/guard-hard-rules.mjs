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
// matter most (migrations, lint suppressions).
//
// Tested by mobile/__tests__/repo/claude-hooks.test.ts, which runs this file
// as a process, the way the harness does.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
    'CLAUDE.md, Work Hygiene: never `git checkout -- <path>` (or `git checkout <path>`, `git checkout .`). It discards uncommitted work, which may belong to another session.',
  forcePush:
    "CLAUDE.md, Work Hygiene: a force-push needs the owner's OK first (several sessions share these branches).",
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

/** Index of the `)` that closes the `(` at `open`, or the end of the text. */
function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Index of the next unescaped backtick after `from`, or the end of the text. */
function closingBacktick(text, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '`') return i;
  }
  return text.length;
}

/**
 * Split a command line into items, in order:
 *   { type: 'cmd', words }   one simple command, quotes resolved
 *   { type: 'open' | 'close' }  a subshell or command-substitution boundary
 *   { type: 'nested', text }  a substitution found inside quotes or backticks
 * Here-document bodies are skipped: they are data (an issue body, a script).
 */
function parse(text) {
  const items = [];
  let words = [];
  let word = '';
  let inWord = false;
  let arithmetic = 0;
  let heredocs = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) items.push({ type: 'cmd', words });
    words = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\\') {
      if (next !== '\n') {
        word += next ?? '';
        inWord = true;
      }
      i += 1;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j += 1) {
        if (text[j] === '\\' && j + 1 < text.length) {
          // An escaped character is literal: \` and \$( run nothing.
          word += text[j + 1];
          j += 1;
        } else if (text[j] === '`') {
          const stop = closingBacktick(text, j + 1);
          items.push({ type: 'nested', text: text.slice(j + 1, stop) });
          j = stop;
        } else if (text[j] === '$' && text[j + 1] === '(' && text[j + 2] !== '(') {
          const stop = matchingParen(text, j + 1);
          items.push({ type: 'nested', text: text.slice(j + 2, stop) });
          j = stop;
        } else {
          word += text[j];
        }
      }
      inWord = true;
      i = j;
    } else if (ch === '`') {
      const stop = closingBacktick(text, i + 1);
      items.push({ type: 'nested', text: text.slice(i + 1, stop) });
      inWord = true;
      i = stop;
    } else if (ch === '#' && !inWord) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
    } else if (ch === '<' && next === '<' && arithmetic > 0) {
      word += '<<';
      inWord = true;
      i += 1;
    } else if (ch === '<' && next === '<' && text[i + 2] === '<') {
      // A here-string: `<<< word`. The word is data, the next line is not.
      endWord();
      words.push('<');
      i += 2;
    } else if (ch === '<' && next === '<') {
      const match = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(text.slice(i));
      endWord();
      if (match) {
        heredocs.push({ terminator: match[3], stripTabs: match[1] === '-' });
        i += match[0].length - 1;
      } else {
        words.push('<');
        i += 1;
      }
    } else if (ch === '<') {
      endWord();
      words.push('<');
    } else if (ch === '>') {
      endWord();
      words.push('>');
      if (next === '>') i += 1;
      if (text[i + 1] === '|' || text[i + 1] === '&') i += 1;
    } else if (ch === '\n') {
      endSegment();
      for (const { terminator, stripTabs } of heredocs) {
        let lineStart = i + 1;
        for (;;) {
          const lineEnd = text.indexOf('\n', lineStart);
          const stop = lineEnd === -1 ? text.length : lineEnd;
          const line = text.slice(lineStart, stop);
          i = stop;
          if ((stripTabs ? line.replace(/^\t+/, '') : line) === terminator || lineEnd === -1) break;
          lineStart = stop + 1;
        }
      }
      heredocs = [];
    } else if (ch === '(' && next === '(') {
      arithmetic += 1;
      word += '((';
      inWord = true;
      i += 1;
    } else if (ch === ')' && next === ')' && arithmetic > 0) {
      arithmetic -= 1;
      word += '))';
      i += 1;
    } else if (ch === '(') {
      endSegment();
      items.push({ type: 'open' });
    } else if (ch === ')') {
      endSegment();
      items.push({ type: 'close' });
    } else if (ch === ';' || ch === '&' || ch === '|') {
      endSegment();
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endSegment();
  return items;
}

/** Shell keywords that precede a command. */
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
/** Commands that run another command, with the flags of theirs that take a value. */
const WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C'],
  command: [],
  exec: ['-a'],
  time: ['-o', '-f'],
  nohup: [],
  nice: ['-n'],
  env: ['-u', '-C', '-S'],
  caffeinate: ['-t', '-w'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-n', '-I', '-P', '-L', '-d', '-s', '-E', '-J', '-R'],
};
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const READ_ONLY = new Set(['grep', 'rg', 'echo', 'printf', 'cat', 'git', 'gh', 'ls', 'find']);
/** git options that take their value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const isManifest = (w) => /(^|\/)binary-manifest\.json$/.test(w);

function isInMobile(dir) {
  return path.resolve(dir).split(path.sep).includes('mobile');
}

/** Strip assignments, keywords and wrapper commands from the front of a segment. */
function unwrap(allWords) {
  let words = allWords;
  const assigns = [];
  for (;;) {
    if (words.length === 0) break;
    const name = path.basename(words[0]);
    if (isAssignment(words[0])) {
      assigns.push(words[0]);
      words = words.slice(1);
    } else if (KEYWORDS.has(words[0])) {
      words = words.slice(1);
    } else if (Object.hasOwn(WRAPPERS, name)) {
      const valueFlags = WRAPPERS[name];
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += valueFlags.includes(words[i]) ? 2 : 1;
      if (name === 'timeout') i += 1; // the duration
      words = words.slice(i);
    } else {
      break;
    }
  }
  return { words, assigns };
}

function checkGit(args, dir) {
  let gitDir = dir;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' && args[i + 1]) gitDir = path.resolve(gitDir, args[i + 1]);
    i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);

  if (sub === 'reset') return deny('gitReset');
  if (sub === 'stash' && rest[0] !== 'list' && rest[0] !== 'show') return deny('gitStash');

  if (sub === 'checkout') {
    const dashes = rest.indexOf('--');
    if (dashes !== -1) return dashes < rest.length - 1 ? deny('gitCheckoutPaths') : null;
    const createsBranch = rest.some((a) => a === '-b' || a === '-B' || a === '--orphan');
    const namesPath = rest.some((a) => !a.startsWith('-') && fs.existsSync(path.resolve(gitDir, a)));
    if (!createsBranch && namesPath) return deny('gitCheckoutPaths');
  }

  if (
    sub === 'push' &&
    rest.some(
      (a) => a === '--force' || a.startsWith('--force-') || /^-[a-eg-z]*f[a-z]*$/.test(a) || a.startsWith('+'),
    )
  ) {
    return ask('forcePush');
  }

  if ((sub === 'rm' || sub === 'mv') && rest.some(isManifest)) return deny('binaryManifest');
  return null;
}

function checkSegment(allWords, state) {
  const { words, assigns } = unwrap(allWords);
  if (words.length === 0) return null;
  const cmd = path.basename(words[0]);
  const args = words.slice(1);

  if (cmd === 'cd' && args[0] && !args[0].startsWith('-')) {
    state.dir = path.resolve(state.dir, args[0].replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    return null;
  }

  if (SHELLS.has(cmd)) {
    const flag = args.findIndex((a) => /^-[a-z]*c$/.test(a));
    return flag !== -1 && args[flag + 1] ? checkCommand(args[flag + 1], state.dir) : null;
  }
  if (cmd === 'eval') return checkCommand(args.join(' '), state.dir);

  if (cmd === 'git') {
    const verdict = checkGit(args, state.dir);
    if (verdict) return verdict;
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

  // Writes to the binary manifest: a redirect onto it from any command, or a
  // command that changes the file it is given.
  if (allWords.some((w, i) => isManifest(w) && allWords[i - 1] === '>')) return deny('binaryManifest');
  if (args.some(isManifest)) {
    const inPlace =
      (cmd === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) ||
      (cmd === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a)));
    const isDestination = (cmd === 'cp' || cmd === 'mv') && isManifest(args[args.length - 1]);
    const isSource = cmd === 'mv' && args.slice(0, -1).some(isManifest);
    if (inPlace || isDestination || isSource || ['tee', 'rm', 'truncate'].includes(cmd)) {
      return deny('binaryManifest');
    }
  }

  return null;
}

function checkCommand(command, startDir) {
  const state = { dir: startDir };
  const saved = [];
  for (const item of parse(command)) {
    let verdict = null;
    if (item.type === 'open') saved.push(state.dir);
    else if (item.type === 'close') state.dir = saved.pop() ?? state.dir;
    else if (item.type === 'nested') verdict = checkCommand(item.text, state.dir);
    else verdict = checkSegment(item.words, state);
    if (verdict) return verdict;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File edits.
// ---------------------------------------------------------------------------

/** `target` with symlinks resolved, even when the file does not exist yet. */
function realPath(target) {
  let existing = target;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function repoRoot(dir) {
  let existing = dir;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  try {
    const root = execFileSync('git', ['-C', existing, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return fs.realpathSync(root);
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

const DIRECTIVE = /(\/\/|\/\*)\s*eslint-disable/g;
const countDirectives = (texts) =>
  texts.filter((t) => typeof t === 'string').reduce((n, t) => n + (t.match(DIRECTIVE)?.length ?? 0), 0);

function checkEdit(toolInput, cwd) {
  const filePath = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof filePath !== 'string') return null;
  const absolute = realPath(path.resolve(cwd, filePath));
  const root = repoRoot(path.dirname(absolute));
  const rel = root ? path.relative(root, absolute).split(path.sep).join('/') : absolute;

  if (rel === 'mobile/binary-manifest.json') return deny('binaryManifest');

  if (root && rel.startsWith('backend/prisma/migrations/') && isOnMain(root, rel)) {
    return deny('mergedMigration');
  }

  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel) && !ESLINT_DISABLE_ALLOWED.includes(rel)) {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    const added = countDirectives([
      toolInput.new_string,
      toolInput.content,
      toolInput.new_source,
      ...edits.map((e) => e?.new_string),
    ]);
    const removed = countDirectives([toolInput.old_string, ...edits.map((e) => e?.old_string)]);
    if (added > removed) return deny('eslintDisable');
  }

  return null;
}

// ---------------------------------------------------------------------------

function decide(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const toolInput = input.tool_input ?? {};
  if (input.tool_name === 'Bash') {
    return typeof toolInput.command === 'string' ? checkCommand(toolInput.command, cwd) : null;
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
