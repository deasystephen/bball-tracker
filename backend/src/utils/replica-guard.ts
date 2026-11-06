import { logger } from './logger';

/**
 * Single-replica startup guard (#446).
 *
 * The API was single-replica by construction: Socket.io used the in-memory
 * adapter (rooms are local to one process) and every rate limiter kept its
 * counters in process memory. With a second task a live game splits silently
 * — the coach tracks on task A, the parents watch on task B, nobody sees an
 * error — and every rate limit becomes N times its budget. #452 moved the
 * HTTP and socket-handshake rate limits to Redis and added the Redis adapter
 * (`websocket/redis-adapter.ts`, enabled by `REDIS_SOCKET_ADAPTER_URL`); the
 * per-IP socket cap is still per task. The guard stays closed until the
 * cross-task cap and a load test on two tasks flip `MULTI_REPLICA_SUPPORTED`.
 *
 * A process cannot observe the autoscaling target, so the replica ceiling is
 * explicit configuration: `MAX_REPLICAS` in `infra/task-definition.json`, pinned
 * by `tests/infra/replica-ceiling.test.ts` to the `max_capacity` default in
 * `infra/variables.tf`. The guard is configuration-based on purpose: a rolling
 * deploy briefly runs two tasks (`deployment_maximum_percent = 200`) and must
 * not trip it.
 *
 * `REDIS_SOCKET_ADAPTER_URL` is NOT yet accepted as proof of safety: the
 * adapter is wired, but cross-task delivery has only been proven in Jest
 * (`tests/integration/socket-redis-adapter.redis.test.ts`), not on two ECS
 * tasks. The follow-up to #452 sets the URL in the task definition, runs that
 * load test and flips `MULTI_REPLICA_SUPPORTED`; from then on a ceiling above
 * 1 is allowed only when the URL is set.
 */

export const MAX_REPLICAS_ENV_VAR = 'MAX_REPLICAS';
export const SOCKET_ADAPTER_URL_ENV_VAR = 'REDIS_SOCKET_ADAPTER_URL';

/** Open follow-up for the Redis adapter + shared rate-limit store. */
export const REDIS_ADAPTER_ISSUE = '#452';

/**
 * Whether this build can run more than one replica at all. The adapter and the
 * shared rate-limit store are in (#452); this stays false until the cross-task
 * socket cap and the two-task load test that follow it.
 */
export const MULTI_REPLICA_SUPPORTED = false;

export type ReplicaGuardAction = 'start' | 'warn' | 'exit';

export type ReplicaGuardReason =
  | 'not-production'
  | 'single-replica'
  | 'ceiling-unset'
  | 'ceiling-invalid'
  | 'multi-replica-unsupported'
  | 'multi-replica-without-adapter'
  | 'multi-replica-with-adapter';

export interface ReplicaGuardDecision {
  /** `start`: boot normally. `warn`: boot, but log at error level. `exit`: refuse to boot. */
  action: ReplicaGuardAction;
  reason: ReplicaGuardReason;
  /** The parsed ceiling, or `null` when it is unset, invalid or not evaluated. */
  maxReplicas: number | null;
  /** Human-readable explanation; empty when there is nothing worth logging. */
  message: string;
}

export interface ReplicaGuardOptions {
  /** Defaults to `MULTI_REPLICA_SUPPORTED`. Injectable so both branches stay tested. */
  multiReplicaSupported?: boolean;
}

export interface ReplicaGuardDeps {
  log: Pick<typeof logger, 'info' | 'error'>;
  exit: (code: number) => void;
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

const SINGLE_REPLICA_WHY =
  'The HTTP and socket-handshake rate limits are shared through Redis and the Socket.io Redis adapter ' +
  `exists (${SOCKET_ADAPTER_URL_ENV_VAR}), but the per-IP socket cap is still per task and cross-task ` +
  'delivery has not been load-tested on two tasks, so MULTI_REPLICA_SUPPORTED is still false and a ' +
  'second replica is not yet trusted with live games.';

/**
 * Parses a replica ceiling. Returns `undefined` for unset/blank, `null` for
 * anything that is not a positive safe integer written in plain decimal.
 */
export function parseMaxReplicas(raw: string | undefined): number | null | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!POSITIVE_INTEGER.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Pure decision function: reads the environment, touches nothing.
 *
 * | NODE_ENV   | MAX_REPLICAS      | decision                                   |
 * | ---------- | ----------------- | ------------------------------------------ |
 * | not prod   | anything          | start (silent)                             |
 * | production | unset / blank     | warn  (boots; pre-guard behaviour)         |
 * | production | not a positive int| exit                                       |
 * | production | 1                 | start (info)                               |
 * | production | > 1               | exit  (until the #452 load test; then needs adapter URL) |
 *
 * Unset is a warning rather than a failure so the deploy that introduces the
 * guard — or a rollback to a task definition that predates it — cannot
 * crash-loop production. The infra test is what guarantees production sets it.
 */
export function evaluateReplicaGuard(
  env: NodeJS.ProcessEnv = process.env,
  options: ReplicaGuardOptions = {}
): ReplicaGuardDecision {
  const multiReplicaSupported = options.multiReplicaSupported ?? MULTI_REPLICA_SUPPORTED;

  if (env.NODE_ENV !== 'production') {
    return { action: 'start', reason: 'not-production', maxReplicas: null, message: '' };
  }

  const raw = env[MAX_REPLICAS_ENV_VAR];
  const maxReplicas = parseMaxReplicas(raw);

  if (maxReplicas === undefined) {
    return {
      action: 'warn',
      reason: 'ceiling-unset',
      maxReplicas: null,
      message:
        `${MAX_REPLICAS_ENV_VAR} is not set, so the single-replica guard cannot verify the replica ceiling. ` +
        `${SINGLE_REPLICA_WHY} Set ${MAX_REPLICAS_ENV_VAR}=1 in infra/task-definition.json and keep the ` +
        `autoscaling max_capacity at 1 until the two-task load test (${REDIS_ADAPTER_ISSUE}) flips MULTI_REPLICA_SUPPORTED.`,
    };
  }

  if (maxReplicas === null) {
    return {
      action: 'exit',
      reason: 'ceiling-invalid',
      maxReplicas: null,
      message:
        `Refusing to start: ${MAX_REPLICAS_ENV_VAR}=${JSON.stringify(raw)} is not a positive integer, ` +
        `so the replica ceiling cannot be verified. ${SINGLE_REPLICA_WHY} ` +
        `Set ${MAX_REPLICAS_ENV_VAR}=1 in infra/task-definition.json.`,
    };
  }

  if (maxReplicas === 1) {
    return {
      action: 'start',
      reason: 'single-replica',
      maxReplicas,
      message:
        `Replica ceiling is 1 (${MAX_REPLICAS_ENV_VAR}). Scaling out waits for the two-task load test ` +
        `of the Socket.io Redis adapter (${REDIS_ADAPTER_ISSUE}).`,
    };
  }

  if (!multiReplicaSupported) {
    return {
      action: 'exit',
      reason: 'multi-replica-unsupported',
      maxReplicas,
      message:
        `Refusing to start: ${MAX_REPLICAS_ENV_VAR}=${maxReplicas} but this build is single-replica only. ` +
        `${SINGLE_REPLICA_WHY} Until then ${SOCKET_ADAPTER_URL_ENV_VAR} has no effect on this check ` +
        `and does not make this safe. Set ${MAX_REPLICAS_ENV_VAR}=1 and max_capacity=1 until the load ` +
        `test for ${REDIS_ADAPTER_ISSUE} flips MULTI_REPLICA_SUPPORTED.`,
    };
  }

  if (!env[SOCKET_ADAPTER_URL_ENV_VAR]?.trim()) {
    return {
      action: 'exit',
      reason: 'multi-replica-without-adapter',
      maxReplicas,
      message:
        `Refusing to start: ${MAX_REPLICAS_ENV_VAR}=${maxReplicas} without ${SOCKET_ADAPTER_URL_ENV_VAR}. ` +
        `${SINGLE_REPLICA_WHY} Set ${SOCKET_ADAPTER_URL_ENV_VAR} or lower the ceiling to 1.`,
    };
  }

  return {
    action: 'start',
    reason: 'multi-replica-with-adapter',
    maxReplicas,
    message: `Replica ceiling is ${maxReplicas} (${MAX_REPLICAS_ENV_VAR}) with the Socket.io Redis adapter configured.`,
  };
}

/**
 * Evaluates the guard and acts on it: logs, and exits non-zero when the
 * configuration would split live games. Call it BEFORE `httpServer.listen` so a
 * misconfigured task never accepts a connection (the ECS deployment circuit
 * breaker then rolls the deploy back).
 */
export function enforceReplicaGuard(
  env: NodeJS.ProcessEnv = process.env,
  deps: ReplicaGuardDeps = { log: logger, exit: (code) => process.exit(code) },
  options: ReplicaGuardOptions = {}
): ReplicaGuardDecision {
  const decision = evaluateReplicaGuard(env, options);
  const context = { guard: 'replica-ceiling', reason: decision.reason, maxReplicas: decision.maxReplicas };

  if (decision.action === 'exit') {
    deps.log.error(decision.message, context);
    deps.exit(1);
  } else if (decision.action === 'warn') {
    deps.log.error(decision.message, context);
  } else if (decision.message) {
    deps.log.info(decision.message, context);
  }

  return decision;
}
