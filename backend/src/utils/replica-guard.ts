import { logger } from './logger';

/**
 * Single-replica startup guard (#446).
 *
 * The API is single-replica by construction: Socket.io uses the in-memory
 * adapter (rooms are local to one process) and every rate limiter keeps its
 * counters in process memory (`websocket/rate-limit.ts`, the default
 * `express-rate-limit` MemoryStore). With a second task a live game splits
 * silently — the coach tracks on task A, the parents watch on task B, nobody
 * sees an error — and every rate limit becomes N times its budget.
 *
 * A process cannot observe the autoscaling target, so the replica ceiling is
 * explicit configuration: `MAX_REPLICAS` in `infra/task-definition.json`, pinned
 * by `tests/infra/replica-ceiling.test.ts` to the `max_capacity` default in
 * `infra/variables.tf`. The guard is configuration-based on purpose: a rolling
 * deploy briefly runs two tasks (`deployment_maximum_percent = 200`) and must
 * not trip it.
 *
 * `REDIS_SOCKET_ADAPTER_URL` is deliberately NOT accepted as proof of safety
 * today. `@socket.io/redis-adapter` is not installed and nothing reads that
 * URL, so treating it as an escape hatch would be false assurance: setting one
 * env var would silence the guard while rooms still split. The change that
 * installs and wires the adapter and a shared rate-limit store (#452) flips
 * `MULTI_REPLICA_SUPPORTED`; from then on a ceiling above 1 is allowed only
 * when the URL is set.
 */

export const MAX_REPLICAS_ENV_VAR = 'MAX_REPLICAS';
export const SOCKET_ADAPTER_URL_ENV_VAR = 'REDIS_SOCKET_ADAPTER_URL';

/** Open follow-up for the Redis adapter + shared rate-limit store. */
export const REDIS_ADAPTER_ISSUE = '#452';

/**
 * Whether this build can run more than one replica at all. False until #452
 * installs `@socket.io/redis-adapter`, wires it to `REDIS_SOCKET_ADAPTER_URL`
 * and moves the rate-limit counters to a shared store.
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
  'Socket.io uses the in-memory adapter and rate-limit counters live in process memory, ' +
  'so a second replica silently splits live-game rooms and multiplies every rate limit.';

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
 * | production | > 1               | exit  (until #452; then needs adapter URL) |
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
        `autoscaling max_capacity at 1 until the Redis adapter lands (${REDIS_ADAPTER_ISSUE}).`,
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
        `Replica ceiling is 1 (${MAX_REPLICAS_ENV_VAR}); Socket.io runs on the in-memory adapter. ` +
        `Scaling out requires the Redis adapter (${REDIS_ADAPTER_ISSUE}).`,
    };
  }

  if (!multiReplicaSupported) {
    return {
      action: 'exit',
      reason: 'multi-replica-unsupported',
      maxReplicas,
      message:
        `Refusing to start: ${MAX_REPLICAS_ENV_VAR}=${maxReplicas} but this build is single-replica only. ` +
        `${SINGLE_REPLICA_WHY} @socket.io/redis-adapter is not wired up, so ` +
        `${SOCKET_ADAPTER_URL_ENV_VAR} has no effect and does not make this safe. ` +
        `Set ${MAX_REPLICAS_ENV_VAR}=1 and max_capacity=1 until ${REDIS_ADAPTER_ISSUE} lands.`,
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
