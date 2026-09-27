/**
 * Config-bound test over the replica ceiling (#446).
 *
 * The API is single-replica by construction (in-memory Socket.io adapter,
 * in-memory rate-limit stores), and the ceiling is written in two
 * machine-consumed files that cannot share a constant:
 *
 *   - `infra/variables.tf`         — `max_capacity`, what ECS autoscaling may run
 *   - `infra/task-definition.json` — `MAX_REPLICAS`, what the API's startup guard
 *                                    (`src/utils/replica-guard.ts`) believes
 *
 * If they drift, the guard checks a number production does not run on. This
 * suite fails on any disagreement, and every extraction must succeed — a file
 * that changed shape fails loudly rather than passing vacuously.
 *
 * It also evaluates the real guard against the production environment block,
 * so a deploy file that would make the API refuse to start (or boot with the
 * guard unconfigured) fails CI instead of tripping the ECS circuit breaker.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { evaluateReplicaGuard, MAX_REPLICAS_ENV_VAR } from '../../src/utils/replica-guard';

const ROOT = path.resolve(__dirname, '../../..');
const VARIABLES_TF = path.join(ROOT, 'infra/variables.tf');
const ECS_TF = path.join(ROOT, 'infra/ecs.tf');
const TASK_DEFINITION = path.join(ROOT, 'infra/task-definition.json');

interface TaskDefinition {
  containerDefinitions: Array<{ environment?: Array<{ name: string; value: string }> }>;
}

/** Returns the body of `variable "<name>" { … }`, brace-matched. */
export function extractVariableBlock(source: string, name: string, label: string): string {
  const header = new RegExp(`^variable\\s+"${name}"\\s*\\{`, 'm').exec(source);
  if (!header) {
    throw new Error(
      `${label}: could not find variable "${name}". If the file changed shape, update ` +
        'tests/infra/replica-ceiling.test.ts — do not let this test pass vacuously.'
    );
  }
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i);
  }
  throw new Error(`${label}: variable "${name}" has no closing brace.`);
}

export function extractNumericDefault(block: string, label: string): number {
  const match = /^\s*default\s*=\s*(\d+)\s*$/m.exec(block);
  if (!match) {
    throw new Error(`${label}: could not find a numeric \`default = N\` line.`);
  }
  return Number(match[1]);
}

function readVariable(name: string): { block: string; defaultValue: number } {
  const label = `infra/variables.tf variable "${name}"`;
  const block = extractVariableBlock(readFileSync(VARIABLES_TF, 'utf8'), name, label);
  return { block, defaultValue: extractNumericDefault(block, label) };
}

function readProductionEnv(): Record<string, string> {
  const td = JSON.parse(readFileSync(TASK_DEFINITION, 'utf8')) as TaskDefinition;
  return Object.fromEntries(td.containerDefinitions.flatMap((c) => c.environment ?? []).map((e) => [e.name, e.value]));
}

describe('replica ceiling — variables.tf / task-definition.json parity (#446)', () => {
  const maxCapacity = readVariable('max_capacity');
  const minCapacity = readVariable('min_capacity');
  const env = readProductionEnv();

  it('MAX_REPLICAS in the task definition equals the max_capacity default', () => {
    expect(env[MAX_REPLICAS_ENV_VAR]).toBeDefined();
    expect(env[MAX_REPLICAS_ENV_VAR]).toBe(String(maxCapacity.defaultValue));
  });

  it('the autoscaling ceiling is 1 while the API is single-replica', () => {
    expect(maxCapacity.defaultValue).toBe(1);
    expect(minCapacity.defaultValue).toBe(1);
  });

  it('max_capacity and min_capacity carry a validation block, so a tfvars override cannot raise them', () => {
    expect(maxCapacity.block).toMatch(/validation\s*\{[^}]*condition\s*=\s*var\.max_capacity\s*==\s*1\b/);
    expect(minCapacity.block).toMatch(/validation\s*\{[^}]*condition\s*=\s*contains\(\[0,\s*1\],\s*var\.min_capacity\)/);
  });

  it('the autoscaling target still reads both variables', () => {
    const ecs = readFileSync(ECS_TF, 'utf8');
    expect(ecs).toMatch(/^\s*max_capacity\s*=\s*var\.max_capacity\s*$/m);
    expect(ecs).toMatch(/^\s*min_capacity\s*=\s*var\.min_capacity\s*$/m);
  });

  it('the production environment passes the startup guard as a configured single replica', () => {
    expect(env.NODE_ENV).toBe('production');
    expect(evaluateReplicaGuard(env)).toMatchObject({
      action: 'start',
      reason: 'single-replica',
      maxReplicas: 1,
    });
  });

  describe('extraction helpers fail loudly', () => {
    it('throws when the variable is missing', () => {
      expect(() => extractVariableBlock('variable "other" {\n  default = 1\n}\n', 'max_capacity', 'fixture')).toThrow(
        /could not find variable "max_capacity"/
      );
    });

    it('throws when the block never closes', () => {
      expect(() => extractVariableBlock('variable "max_capacity" {\n  default = 1\n', 'max_capacity', 'fixture')).toThrow(
        /no closing brace/
      );
    });

    it('throws when there is no numeric default', () => {
      expect(() => extractNumericDefault('\n  type = number\n', 'fixture')).toThrow(/numeric `default = N`/);
    });

    it('reads the default past a nested validation block', () => {
      const source = [
        'variable "max_capacity" {',
        '  type    = number',
        '  validation {',
        '    condition = var.max_capacity == 1',
        '  }',
        '  default = 7',
        '}',
        'variable "later" {',
        '  default = 9',
        '}',
      ].join('\n');
      const block = extractVariableBlock(source, 'max_capacity', 'fixture');
      expect(extractNumericDefault(block, 'fixture')).toBe(7);
      expect(block).not.toContain('later');
    });
  });
});
