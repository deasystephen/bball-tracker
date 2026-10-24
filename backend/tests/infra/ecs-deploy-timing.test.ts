/**
 * Config-bound test over the two ECS/ALB timings that shape a deploy
 * (#752, #748). Detail: docs/deployment/ecs-deploys.md, "ECS deploy safety".
 *
 * - `health_check_grace_period_seconds` on `aws_ecs_service.app`: the
 *   entrypoint runs `prisma migrate deploy` before node listens, so without a
 *   grace period ECS stops a migrating task after the target group's
 *   `unhealthy_threshold * interval` and a migration killed mid-flight pins
 *   every later deploy on P3009. The documented migration budget (about 200 s)
 *   assumes 300 s, and the grace period must also outlast the container health
 *   check's own unhealthy point (`startPeriod + interval * retries` in
 *   infra/task-definition.json), which it covers too.
 * - `deregistration_delay` on `aws_lb_target_group.app`: the ALB holds a
 *   draining target's WebSockets for the whole delay and ECS sends SIGTERM only
 *   after it, so this is how long a deploy splits a live game (the AWS default
 *   is 300 s). It must outlast the slowest bounded request (finishing a game,
 *   which awaits finalizeGameStats) and stay at or under 30 s, or the
 *   "splits live games for under a minute" rule in the docs is wrong.
 *
 * CI runs `terraform validate`, which cannot tell a dropped attribute from an
 * intended default, so this suite keeps both lines from vanishing or drifting
 * in an unrelated edit. Every extraction fails loudly when the file changed shape.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { DB_CONNECTION_TIMEOUT_MS } from '../../src/models/pool-config';
import { FINALIZE_TRANSACTION_TIMEOUT_MS } from '../../src/services/stats-service';
import { resourceBlock } from './terraform';
import { ROOT } from './workflows';

const ECS_TF = path.join(ROOT, 'infra/ecs.tf');
const TASK_DEFINITION = path.join(ROOT, 'infra/task-definition.json');

/** The grace period the documented ~200 s migration budget is computed from. */
const MIN_GRACE_PERIOD_S = 300;
/** ECS takes up to ~25 s to start the drain; past 30 s the split is no longer "under a minute". */
const MAX_DEREGISTRATION_DELAY_S = 30;
/** Prisma's default interactive-transaction `maxWait` (finalizeGameStats does not set one). */
const PRISMA_DEFAULT_MAX_WAIT_MS = 2_000;

function numericAttribute(block: string, name: string, label: string): number {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(block);
  if (!match) {
    throw new Error(`${label}: could not find a numeric \`${name} = N\` line.`);
  }
  return Number(match[1]);
}

interface TaskDefinition {
  containerDefinitions: Array<{
    name: string;
    healthCheck?: { interval: number; retries: number; startPeriod: number };
  }>;
}

describe('ECS deploy timing (infra/ecs.tf)', () => {
  const service = resourceBlock(ECS_TF, 'aws_ecs_service', 'app');
  const targetGroup = resourceBlock(ECS_TF, 'aws_lb_target_group', 'app');

  it('gives a migrating task a grace period before health checks count (#752)', () => {
    const grace = numericAttribute(service, 'health_check_grace_period_seconds', 'aws_ecs_service.app');
    expect(grace).toBeGreaterThanOrEqual(MIN_GRACE_PERIOD_S);

    const td = JSON.parse(readFileSync(TASK_DEFINITION, 'utf8')) as TaskDefinition;
    const hc = td.containerDefinitions.find((c) => c.name === 'api')?.healthCheck;
    if (!hc) throw new Error('infra/task-definition.json: container "api" has no healthCheck.');
    expect(grace).toBeGreaterThanOrEqual(hc.startPeriod + hc.interval * hc.retries);
  });

  it('drains the old task long enough for a finish-game request, and no longer (#748)', () => {
    const delayMs =
      numericAttribute(targetGroup, 'deregistration_delay', 'aws_lb_target_group.app') * 1000;
    const finishGameBoundMs =
      DB_CONNECTION_TIMEOUT_MS + PRISMA_DEFAULT_MAX_WAIT_MS + FINALIZE_TRANSACTION_TIMEOUT_MS;
    expect(delayMs).toBeGreaterThan(finishGameBoundMs);
    expect(delayMs).toBeLessThanOrEqual(MAX_DEREGISTRATION_DELAY_S * 1000);
  });
});
