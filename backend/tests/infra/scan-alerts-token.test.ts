/**
 * The Daily Upgrade Scan's alert snapshot fails a scheduled run on an empty
 * or missing DEPENDABOT_ALERTS_TOKEN (#1093).
 *
 * On 2026-11-22 the secret was re-stored with an empty value and two scheduled
 * runs went green while blind to the Dependabot alert list. This suite pulls
 * the step's `run:` script out of `.github/workflows/daily-upgrade-scan.yml`
 * and runs it under bash with an empty token: a scheduled run must exit
 * non-zero naming the secret; a manual (`workflow_dispatch`) run may skip the
 * snapshot and write the `{"error": …}` file the prompt falls back on.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { WORKFLOWS_DIR } from './workflows';

const STEP_NAME = 'Snapshot open Dependabot alerts';

/** The literal `run: |` block of the named step, dedented. */
export function stepRunScript(source: string, stepName: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) throw new Error(`step "${stepName}" not found`);
  const stepIndent = lines[start].search(/\S/);
  let end = lines.findIndex((line, i) => i > start && line.trim() !== '' && line.search(/\S/) <= stepIndent);
  if (end === -1) end = lines.length;
  const runAt = lines.findIndex((line, i) => i > start && i < end && /^\s*run:\s*\|\s*$/.test(line));
  if (runAt === -1) throw new Error(`step "${stepName}" has no run: | block`);
  const runIndent = lines[runAt].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

interface SnapshotRun {
  status: number | null;
  stdout: string;
  snapshot: string | null;
  output: string;
}

function runSnapshot(eventName: string, token: string | undefined): SnapshotRun {
  const script = stepRunScript(readFileSync(path.join(WORKFLOWS_DIR, 'daily-upgrade-scan.yml'), 'utf8'), STEP_NAME);
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-alerts-'));
  try {
    // A fake `gh` that answers the alerts call with an empty list, so the
    // token-present path runs without a network or a real PAT.
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: path.join(dir, 'output'),
      GITHUB_EVENT_NAME: eventName,
      GITHUB_REPOSITORY: 'example/repo',
    };
    if (token !== undefined) env.GH_TOKEN = token;
    const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
    let snapshot: string | null = null;
    try {
      snapshot = readFileSync(path.join(dir, 'dependabot-alerts.json'), 'utf8');
    } catch {
      snapshot = null;
    }
    let output = '';
    try {
      output = readFileSync(path.join(dir, 'output'), 'utf8');
    } catch {
      output = '';
    }
    return { status: result.status, stdout: result.stdout, snapshot, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('daily upgrade scan: alerts token guard (#1093)', () => {
  it.each([
    ['empty', ''],
    ['missing', undefined],
  ])('fails a scheduled run when the token is %s, naming the secret', (_label, token) => {
    const run = runSnapshot('schedule', token);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('::error::DEPENDABOT_ALERTS_TOKEN is empty or missing');
    expect(run.snapshot).toBeNull();
  });

  it('takes the snapshot on a scheduled run with a token and hands its path on', () => {
    const run = runSnapshot('schedule', 'test-token');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Snapshot: 0 open alert(s)');
    expect(JSON.parse(run.snapshot ?? 'null')).toEqual([]);
    expect(run.output).toMatch(/^path=.*dependabot-alerts\.json$/m);
  });

  it('lets a manual run skip the snapshot with an explicit error file', () => {
    const run = runSnapshot('workflow_dispatch', '');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('::warning::DEPENDABOT_ALERTS_TOKEN is empty or missing');
    expect(JSON.parse(run.snapshot ?? 'null')).toEqual({
      error: expect.stringContaining('DEPENDABOT_ALERTS_TOKEN'),
    });
    expect(run.output).toMatch(/^path=/m);
  });
});
