/**
 * Third-party GitHub Actions are pinned to commit SHAs (#712).
 *
 * A tag can be moved by an action's maintainer, or by whoever compromises the
 * maintainer's account (the `tj-actions/changed-files` tag rewrite of March
 * 2025); a commit SHA cannot. The deploy job in `ci.yml` runs actions with the
 * production AWS keys and the Sentry token in its environment, so every action
 * not owned by GitHub (`actions/`, `github/`) is referenced by a full 40-hex
 * commit SHA with a trailing `# vX.Y.Z` comment. Dependabot's `github-actions`
 * ecosystem (`.github/dependabot.yml`) bumps the SHA and the comment together.
 *
 * This suite scans every workflow under `.github/workflows/` and fails on a
 * third-party reference by tag or branch, and on a pin without its comment.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { WORKFLOWS_DIR, workflowFiles } from './workflows';

/** Owners whose actions may stay on a version tag (GitHub's own). */
export const FIRST_PARTY_OWNERS: ReadonlySet<string> = new Set(['actions', 'github']);

const USES_LINE = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/;
const SHA = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^#\s*v\d+\.\d+\.\d+\b/;

export interface PinViolation {
  file: string;
  line: number;
  reference: string;
  reason: string;
}

export function findPinViolations(source: string, file: string): PinViolation[] {
  const violations: PinViolation[] = [];
  source.split('\n').forEach((text, index) => {
    const match = text.match(USES_LINE);
    if (!match) return;
    const reference = match[1];
    // Local actions and Docker images are not repository refs.
    if (reference.startsWith('./') || reference.startsWith('docker://')) return;
    const owner = reference.split('/')[0];
    if (FIRST_PARTY_OWNERS.has(owner)) return;
    const at = reference.lastIndexOf('@');
    const ref = at === -1 ? '' : reference.slice(at + 1);
    const line = index + 1;
    if (!SHA.test(ref)) {
      violations.push({ file, line, reference, reason: 'not pinned to a 40-character commit SHA' });
    } else if (!VERSION_COMMENT.test((match[2] ?? '').trim())) {
      violations.push({ file, line, reference, reason: 'missing the trailing "# vX.Y.Z" comment' });
    }
  });
  return violations;
}

describe('third-party actions are pinned to commit SHAs', () => {
  it('finds workflows to scan', () => {
    expect(workflowFiles()).toEqual(expect.arrayContaining(['ci.yml']));
  });

  it('every non-GitHub action in every workflow is a SHA pin with a version comment', () => {
    const violations = workflowFiles().flatMap((name) =>
      findPinViolations(readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'), `.github/workflows/${name}`),
    );
    expect(violations).toEqual([]);
  });

  it('pins the deploy job actions that hold the production AWS keys', () => {
    const ci = readFileSync(path.join(WORKFLOWS_DIR, 'ci.yml'), 'utf8');
    for (const action of [
      'aws-actions/configure-aws-credentials',
      'aws-actions/amazon-ecr-login',
      'aws-actions/amazon-ecs-render-task-definition',
      'aws-actions/amazon-ecs-deploy-task-definition',
    ]) {
      expect(ci).toMatch(new RegExp(`uses: ${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
    }
  });
});

describe('action pin scanner — self-test', () => {
  const sha = 'ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d';

  it('accepts SHA pins with a version comment, first-party tags and local actions', () => {
    const source = [
      '      - uses: actions/checkout@v7',
      '        uses: github/codeql-action/init@v4',
      `      - uses: dorny/paths-filter@${sha} # v4.0.3`,
      `        uses: 'aws-actions/amazon-ecr-login@${sha}' # v2.1.7`,
      '      - uses: ./.github/actions/local',
      '      - uses: docker://alpine:3.20',
    ].join('\n');
    expect(findPinViolations(source, 'wf')).toEqual([]);
  });

  it('rejects a third-party tag, branch or short SHA', () => {
    const source = [
      '      - uses: dorny/paths-filter@v4',
      '        uses: hashicorp/setup-terraform@main',
      '        uses: docker/setup-buildx-action@f87e599',
      '        uses: someone/action',
    ].join('\n');
    expect(findPinViolations(source, 'wf').map((v) => v.line)).toEqual([1, 2, 3, 4]);
  });

  it('rejects a SHA pin without its version comment', () => {
    const violations = findPinViolations(`      - uses: dorny/paths-filter@${sha}`, 'wf');
    expect(violations).toEqual([
      { file: 'wf', line: 1, reference: `dorny/paths-filter@${sha}`, reason: 'missing the trailing "# vX.Y.Z" comment' },
    ]);
  });

  it('rejects a version comment that names only a major or a minor', () => {
    const source = [`      - uses: dorny/paths-filter@${sha} # v4`, `      - uses: dorny/paths-filter@${sha} # v4.0`].join('\n');
    expect(findPinViolations(source, 'wf').map((v) => v.reason)).toEqual([
      'missing the trailing "# vX.Y.Z" comment',
      'missing the trailing "# vX.Y.Z" comment',
    ]);
  });
});
