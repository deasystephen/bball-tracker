/**
 * The PreToolUse hook that refuses what CLAUDE.md's hard rules forbid (#1127).
 *
 * The hook is run as a process with the JSON the harness sends, because that
 * is the path a session takes: a unit test of its functions would pass while
 * a broken stdin read or output shape let every call through.
 *
 * It lives in the mobile suite although it guards the whole repo: this job
 * runs on every PR, and a change here does not start an API deploy.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'guard-hard-rules.mjs');
const MOBILE = path.join(REPO_ROOT, 'mobile');
const BACKEND = path.join(REPO_ROOT, 'backend');

interface Verdict {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
}

function runHook(stdin: string): Verdict {
  const result = spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8' });
  expect(result.status).toBe(0);
  if (result.stdout.trim() === '') return { decision: 'allow', reason: '' };
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  expect(output.hookEventName).toBe('PreToolUse');
  return { decision: output.permissionDecision, reason: output.permissionDecisionReason };
}

function bash(command: string, cwd: string = REPO_ROOT): Verdict {
  return runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
}

function edit(tool: string, toolInput: Record<string, string>): Verdict {
  return runHook(JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: REPO_ROOT }));
}

// Built from two halves so this file does not carry the directive it tests for.
const DISABLE_DIRECTIVE = `// eslint-${'disable'}-next-line no-console`;

describe('guard-hard-rules hook: Bash', () => {
  it.each<[string, string, string?]>([
    ['git reset --hard HEAD~1', 'git reset'],
    ['git reset', 'git reset'],
    ['git -C /tmp/elsewhere reset --soft HEAD', 'git reset'],
    ['git status && git stash', 'git stash'],
    ['git stash push -u', 'git stash'],
    ['git stash pop', 'git stash'],
    ['(cd backend; git stash)', 'git stash'],
    ['echo "$(git stash)"', 'git stash'],
    ['bash -c "git stash && git pull"', 'git stash'],
    ['{ git stash; }', 'git stash'],
    // Backticks inside double quotes are a command substitution: the shell would run it.
    ['gh issue create --title "Hook" --body "Deny `git stash` by name"', 'git stash'],
    ['git ls-files | xargs git stash', 'git stash'],
    ['FOO=1 git stash', 'git stash'],
    ['git checkout -- mobile/app.config.js', 'git checkout --'],
    ['git checkout main -- backend/src/index.ts', 'git checkout --'],
    ['git checkout .', 'git checkout --'],
    ['pkill -f metro', 'pkill'],
    ['killall node', 'pkill'],
    ['npm start', 'expo start', MOBILE],
    ['npm run start', 'expo start', MOBILE],
    ['cd mobile && npm start', 'expo start'],
    ['npm --prefix mobile start', 'expo start'],
    ['npx expo start', 'expo start', MOBILE],
    ['npx expo start --dev-client', 'expo start'],
    ['xcodebuild -workspace ios/Hooplings.xcworkspace CODE_SIGNING_ALLOWED=NO build', 'CODE_SIGNING_ALLOWED=NO'],
    ['CODE_SIGNING_ALLOWED=NO npx expo run:ios', 'CODE_SIGNING_ALLOWED=NO'],
    ['xcodebuild "CODE_SIGNING_ALLOWED=NO"', 'CODE_SIGNING_ALLOWED=NO'],
    ['echo "{}" > mobile/binary-manifest.json', 'binary-manifest.json'],
    ["sed -i '' 's/37/38/' mobile/binary-manifest.json", 'binary-manifest.json'],
    ['rm binary-manifest.json', 'binary-manifest.json', MOBILE],
    ['jq . x.json | tee mobile/binary-manifest.json', 'binary-manifest.json'],
  ])('denies `%s`', (...row) => {
    // Read the row by index: a callback with more parameters than the row has
    // columns is handed Jest's `done` in the spare one.
    const [command, reasonMentions, cwd] = row;
    const verdict = bash(command, typeof cwd === 'string' ? cwd : REPO_ROOT);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain(reasonMentions);
  });

  it.each([
    'git push --force origin feature/x',
    'git push -f',
    'git push --force-with-lease origin feature/x',
    'git push origin +feature/x',
  ])('asks before `%s`', (command) => {
    const verdict = bash(command);
    expect(verdict.decision).toBe('ask');
    expect(verdict.reason).toContain('force-push');
  });

  it.each<[string, string?]>([
    ['git checkout main'],
    ['git checkout -b fix/1127-hooks origin/main'],
    ['git restore --staged mobile/app.config.js'],
    ['git stash list'],
    ['git stash show -p'],
    ['git push -u origin feature/x'],
    ['git push --follow-tags'],
    ['git status --short --branch && git log --oneline -5'],
    ['git commit -m "docs: never git stash or git reset in a shared checkout"'],
    ["grep -rn 'git reset' docs/"],
    ["gh issue create --title 'Hook' --body 'Deny `git stash` and pkill by name'"],
    ['gh issue comment 1127 --body-file - <<\'EOF\'\ngit stash\npkill node\nnpm start\nEOF'],
    ['npm start', BACKEND],
    ['cd backend && npm start'],
    ['npm test -- --testPathPattern="start"', MOBILE],
    ['npx expo run:ios'],
    ['npx expo export --platform ios', MOBILE],
    ['BINARY_BUILD=38 BINARY_COMMIT=9f7d5f7 npm run binary-manifest:record', MOBILE],
    ['cat mobile/binary-manifest.json'],
    ['git diff -- mobile/binary-manifest.json'],
    ['grep -rn "CODE_SIGNING_ALLOWED=NO" docs/'],
    ['kill 12345'],
    ['echo done # then git stash'],
  ])('allows `%s`', (...row) => {
    const [command, cwd] = row;
    expect(bash(command, typeof cwd === 'string' ? cwd : REPO_ROOT).decision).toBe('allow');
  });
});

describe('guard-hard-rules hook: file edits', () => {
  const mergedMigration = fs
    .readdirSync(path.join(BACKEND, 'prisma', 'migrations'))
    .filter((name) => /^\d{14}_/.test(name))
    .sort()[0];

  it('denies an edit to mobile/binary-manifest.json', () => {
    const verdict = edit('Edit', {
      file_path: path.join(MOBILE, 'binary-manifest.json'),
      old_string: '37',
      new_string: '38',
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('binary-manifest:record');
  });

  it('denies an edit to a migration that is on main', () => {
    const verdict = edit('Edit', {
      file_path: path.join(BACKEND, 'prisma', 'migrations', mergedMigration, 'migration.sql'),
      old_string: 'a',
      new_string: 'b',
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('Add a new migration');
  });

  it('allows writing a new migration', () => {
    const verdict = edit('Write', {
      file_path: path.join(BACKEND, 'prisma', 'migrations', '29990101000000_not_on_main', 'migration.sql'),
      content: 'ALTER TABLE "Team" ADD COLUMN "x" TEXT;',
    });
    expect(verdict.decision).toBe('allow');
  });

  it('denies adding a lint suppression', () => {
    for (const [tool, input] of [
      ['Edit', { old_string: 'console.log(x);', new_string: `${DISABLE_DIRECTIVE}\nconsole.log(x);` }],
      ['Write', { content: `${DISABLE_DIRECTIVE}\nconsole.log(1);\n` }],
    ] as const) {
      const verdict = edit(tool, { file_path: path.join(MOBILE, 'services', 'log.ts'), ...input });
      expect(verdict.decision).toBe('deny');
      expect(verdict.reason).toContain('Fix the code');
    }
  });

  it('allows an edit that keeps a suppression that was already there, and the two named exceptions', () => {
    expect(
      edit('Edit', {
        file_path: path.join(MOBILE, 'services', 'log.ts'),
        old_string: `${DISABLE_DIRECTIVE}\nconsole.log(x);`,
        new_string: `${DISABLE_DIRECTIVE}\nconsole.log(y);`,
      }).decision,
    ).toBe('allow');
    expect(
      edit('Edit', {
        file_path: path.join(BACKEND, 'src', 'api', 'auth', 'middleware.ts'),
        old_string: 'x',
        new_string: `${DISABLE_DIRECTIVE}\nx`,
      }).decision,
    ).toBe('allow');
  });

  it('allows ordinary edits, and prose that mentions the rule', () => {
    expect(
      edit('Edit', { file_path: path.join(MOBILE, 'services', 'log.ts'), old_string: 'a', new_string: 'b' }).decision,
    ).toBe('allow');
    expect(
      edit('Write', { file_path: path.join(REPO_ROOT, 'docs', 'x.md'), content: `Never add ${DISABLE_DIRECTIVE}.` })
        .decision,
    ).toBe('allow');
  });
});

describe('guard-hard-rules hook: failure modes', () => {
  it('allows the call when its input is not JSON, so a broken guard cannot stop every session', () => {
    expect(runHook('not json').decision).toBe('allow');
  });

  it('ignores tools it does not guard', () => {
    expect(runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } })).decision).toBe('allow');
  });

  it('is the PreToolUse hook the committed settings register', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
    const [entry] = settings.hooks.PreToolUse;
    expect(entry.matcher.split('|')).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    expect(entry.hooks[0].command).toContain('.claude/hooks/guard-hard-rules.mjs');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('check-docs-updated.sh');
  });
});
