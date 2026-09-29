/**
 * What a deploy carries, and which commit production runs (#570).
 *
 * Backend bumps that Dependabot auto-merges start no CI run on main, so they
 * wait there and ship inside the next merge that deploys. Two things make that
 * visible, and both depend on wiring that lives outside the application:
 *
 *  1. `/health` returns the running commit. That only works while the deploy
 *     job writes the commit into `SENTRY_RELEASE` and tags the image with it.
 *  2. The deploy job lists the commits since the running one, with
 *     `.github/scripts/deploy-contents.sh`. That script is run here against a
 *     repository built for the test, because CI's own checkout is shallow.
 *
 * The deploy job itself only runs on main, so nothing here can prove a deploy.
 * These tests pin the pieces a deploy relies on.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const CI_WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const SCRIPT = path.join(ROOT, '.github/scripts/deploy-contents.sh');
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');
const TASK_DEFINITION = readFileSync(path.join(ROOT, 'infra/task-definition.json'), 'utf8');

describe('the running commit reaches /health', () => {
  it('task-definition.json carries the placeholder the deploy job replaces', () => {
    const parsed = JSON.parse(TASK_DEFINITION) as {
      containerDefinitions: Array<{ environment?: Array<{ name: string; value: string }> }>;
    };
    const release = parsed.containerDefinitions
      .flatMap((container) => container.environment ?? [])
      .find((entry) => entry.name === 'SENTRY_RELEASE');
    expect(release?.value).toBe('SENTRY_RELEASE_PLACEHOLDER');
  });

  it('the deploy job replaces it with the commit', () => {
    expect(CI_WORKFLOW).toContain('s/SENTRY_RELEASE_PLACEHOLDER/${{ github.sha }}/g');
  });

  it('the image is tagged with the commit, which is how the deploy job reads the running one', () => {
    expect(CI_WORKFLOW).toMatch(/IMAGE_TAG: \$\{\{ github\.sha \}\}/);
    expect(CI_WORKFLOW).toContain('"$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"');
  });
});

describe('the deploy job', () => {
  it('can be started by hand', () => {
    expect(CI_WORKFLOW).toMatch(/^ {2}workflow_dispatch:\s*$/m);
  });

  it('deploys from main only, for a push or a run started by hand', () => {
    const conditions = CI_WORKFLOW.match(/^ {4}if: .*needs\.detect-changes\.outputs\.backend == 'true'$/m);
    expect(conditions).not.toBeNull();
    expect(conditions?.[0]).toContain("github.ref == 'refs/heads/main'");
    expect(conditions?.[0]).toContain("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
  });

  it('lists what it carries, from a full clone, without being able to block the deploy', () => {
    expect(CI_WORKFLOW).toMatch(/fetch-depth: 0/);
    const step = CI_WORKFLOW.match(/- name: Summarize what this deploy carries\n([\s\S]*?)\n\n/);
    expect(step).not.toBeNull();
    expect(step?.[1]).toContain('continue-on-error: true');
    expect(step?.[1]).toContain('.github/scripts/deploy-contents.sh');
    expect(step?.[1]).toContain('$GITHUB_STEP_SUMMARY');
  });

  it('reports the commit production answers with, without being able to fail the job', () => {
    const step = CI_WORKFLOW.match(/- name: Read the commit production reports\n([\s\S]*)$/);
    expect(step).not.toBeNull();
    expect(step?.[1]).toContain('continue-on-error: true');
    expect(step?.[1]).toContain('.github/scripts/report-deployed-commit.sh');
  });
});

describe('the paths that count as a deploy', () => {
  it('are the same in the path filter and in the script', () => {
    const filter = CI_WORKFLOW.match(/- '\{([^}]+)\}'\n\s+- '!\*\*\/\*\.md'/);
    expect(filter).not.toBeNull();
    const fromFilter = (filter?.[1] ?? '')
      .split(',')
      .map((entry) => entry.replace(/\/\*\*$/, ''))
      .sort();

    const declared = SCRIPT_SOURCE.match(/^DEPLOY_PATHS=\((.*)\)$/m);
    expect(declared).not.toBeNull();
    const entries = (declared?.[1] ?? '').split(/\s+/).filter(Boolean);
    const fromScript = entries.filter((entry) => !entry.startsWith("'")).sort();

    expect(fromScript).toEqual(fromFilter);
    expect(entries).toContain("':(exclude,glob)**/*.md'");
  });
});

describe('deploy-contents.sh', () => {
  let repo: string;
  const commits: Record<string, string> = {};

  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test Author',
        GIT_AUTHOR_EMAIL: 'author@example.test',
        GIT_COMMITTER_NAME: 'Test Author',
        GIT_COMMITTER_EMAIL: 'author@example.test',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();

  const commit = (key: string, file: string, subject: string): void => {
    const target = path.join(repo, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${key}\n`);
    git('add', '--all');
    git('commit', '--quiet', '--message', subject);
    commits[key] = git('rev-parse', 'HEAD');
  };

  const run = (...args: string[]): string => {
    const env = { ...process.env };
    delete env.GITHUB_REPOSITORY;
    return execFileSync('bash', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env });
  };

  const short = (key: string): string => commits[key].slice(0, 7);

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'deploy-contents-'));
    git('init', '--quiet', '--initial-branch=main');
    commit('deployed', 'backend/src/a.ts', 'feat: the commit production runs');
    commit('bump', 'backend/package-lock.json', 'chore(deps): bump a library | with a pipe');
    commit('mobile', 'mobile/app/index.tsx', 'fix(mobile): not part of the image');
    commit('readme', 'backend/README.md', 'docs: markdown under backend');
    commit('infra', 'infra/task-definition.json', 'fix(infra): a new variable');
    commit('feature', 'backend/src/b.ts', 'feat: the change a person merged');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('separates the change that started the deploy from what was merged earlier', () => {
    const out = run(commits.deployed, commits.feature, commits.infra);
    const [started, carried] = out.split('### Merged earlier without a deploy, shipped now');

    expect(started).toContain('### The change that started this deploy');
    expect(started).toContain(`\`${short('feature')}\``);
    expect(started).not.toContain(`\`${short('bump')}\``);

    expect(carried).toContain(`\`${short('bump')}\``);
    expect(carried).toContain('chore(deps): bump a library | with a pipe');
    expect(carried).toContain(`\`${short('infra')}\``);
    expect(carried).toContain('the cause may be one of the commits merged earlier');
  });

  it('leaves out commits that do not change the image: mobile and Markdown', () => {
    const out = run(commits.deployed, commits.feature, commits.infra);
    expect(out).not.toContain(`\`${short('mobile')}\``);
    expect(out).not.toContain(`\`${short('readme')}\``);
    expect(out).toContain('Commits since the running one: 5. Of those, changing what is deployed: 3.');
  });

  it('says so when production was level with main before the change', () => {
    const out = run(commits.infra, commits.feature, commits.infra);
    expect(out).toContain('Nothing. Production was level with `main` before this change.');
    expect(out).not.toContain('the cause may be one of the commits merged earlier');
  });

  it('lists everything in one block for a run started by hand', () => {
    const out = run(commits.deployed, commits.feature, '');
    expect(out).toContain('### Commits that change what is deployed');
    expect(out).toContain(`\`${short('bump')}\``);
    expect(out).toContain(`\`${short('feature')}\``);
  });

  it('names a deploy of the running commit as a restart', () => {
    expect(run(commits.feature, commits.feature)).toContain('changes no code');
  });

  it('says when nothing in between changes the image', () => {
    const out = run(commits.bump, commits.readme, commits.mobile);
    expect(out).toContain('None of the 2 commits in between changes what is deployed');
  });

  it('names what a rollback takes out of production', () => {
    const out = run(commits.feature, commits.deployed);
    expect(out).toContain('The running commit is not an ancestor of the new one');
    expect(out).toContain('### Taken out of production');
    expect(out).toContain(`\`${short('feature')}\``);
  });

  it.each([
    ['nothing', ''],
    ['the text the AWS CLI prints for a missing value', 'None'],
    ['a commit that is not in the clone', 'e87ed33577de095449591fc2ca47640fea8520ce'],
  ])('reports that the running commit could not be read when it is given %s', (_label, deployed) => {
    const out = run(deployed, commits.feature);
    expect(out).toContain('The commit production is running could not be read');
  });

  it('exits 0 with no arguments at all: a summary never stops a deploy', () => {
    expect(() => run()).not.toThrow();
  });
});
