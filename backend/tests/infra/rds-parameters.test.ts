/**
 * Config-bound test over the RDS parameter group and the PostgreSQL log export (#757).
 *
 * Two promises rest on `infra/rds.tf` and nothing else checks them:
 *
 *   - TLS is enforced server-side (`rds.force_ssl = 1`). The backend asks for
 *     TLS itself (backend/src/models/index.ts), so if the server stopped
 *     requiring it nothing in the app would notice; only other clients in the
 *     VPC would silently connect in plaintext.
 *   - The exported PostgreSQL log holds no personal data. Prisma binds every
 *     value, so statements carry placeholders only; the leaks are the DETAIL
 *     line of a constraint error ("Key (email)=(...)", "Failing row contains
 *     (...)"), bind values printed on error, and statement or duration
 *     logging. The retention section of docs/runbooks/data-subject-requests.md,
 *     which the privacy policy must match, describes this log on that basis.
 *
 * `terraform validate` (the only Terraform CI runs) checks none of it. Every
 * extraction fails loudly when the file changed shape.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { resourceBlock, stripComments } from './terraform';
import { ROOT } from './workflows';

const RDS_TF = path.join(ROOT, 'infra/rds.tf');
const DATADOG_TF = path.join(ROOT, 'infra/datadog.tf');

/** Every `parameter { name = "…" value = "…" }` in a parameter-group body, by name. */
export function parameters(block: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /\bparameter\s*\{\s*name\s*=\s*"([^"]+)"\s*value\s*=\s*"([^"]*)"\s*(?:apply_method\s*=\s*"[^"]*"\s*)?\}/g;
  let matched = 0;
  for (const match of block.matchAll(pattern)) {
    if (found.has(match[1])) throw new Error(`parameter "${match[1]}" is declared twice.`);
    found.set(match[1], match[2]);
    matched += 1;
  }
  const opened = [...block.matchAll(/\bparameter\s*\{/g)].length;
  if (matched === 0 || matched !== opened) {
    throw new Error(
      `Read ${matched} of ${opened} \`parameter { … }\` blocks. Each must be written as name, value, ` +
        'then optionally apply_method. If the file changed shape, update ' +
        'backend/tests/infra/rds-parameters.test.ts; do not let a block go unchecked.',
    );
  }
  return found;
}

/** The values the TLS and privacy promises depend on. */
export const REQUIRED_PARAMETERS: Readonly<Record<string, string>> = {
  'rds.force_ssl': '1',
  log_error_verbosity: 'terse',
  log_statement: 'none',
  log_min_duration_statement: '-1',
  log_parameter_max_length_on_error: '0',
};

/** Parameters that would put statement text, bind values or row values in the log. Never set them. */
export const FORBIDDEN_PARAMETERS = [
  'log_duration',
  'log_parameter_max_length',
  // Sampled statement logging: logs statements with their bind values
  // (log_parameter_max_length defaults to unlimited).
  'log_min_duration_sample',
  'log_statement_sample_rate',
  'log_transaction_sample_rate',
  'pgaudit.log',
  'auto_explain.log_min_duration',
  'shared_preload_libraries',
];

describe('RDS parameter group (aws_db_parameter_group.postgres)', () => {
  const group = resourceBlock(RDS_TF, 'aws_db_parameter_group', 'postgres');
  const params = parameters(group);

  it.each(Object.entries(REQUIRED_PARAMETERS))('sets %s = %s', (name, value) => {
    expect(params.get(name)).toBe(value);
  });

  it.each(FORBIDDEN_PARAMETERS)('does not set %s', (name) => {
    expect(params.has(name)).toBe(false);
  });

  it('is attached to the instance', () => {
    const instance = resourceBlock(RDS_TF, 'aws_db_instance', 'main');
    expect(instance).toMatch(/^\s*parameter_group_name\s*=\s*aws_db_parameter_group\.postgres\.name\s*$/m);
  });
});

describe('PostgreSQL log export', () => {
  const instance = resourceBlock(RDS_TF, 'aws_db_instance', 'main');
  const logGroup = resourceBlock(RDS_TF, 'aws_cloudwatch_log_group', 'rds_postgresql');

  it('exports the postgresql log, and only that log', () => {
    expect(instance).toMatch(/^\s*enabled_cloudwatch_logs_exports\s*=\s*\["postgresql"\]\s*$/m);
  });

  it('copies tags to snapshots', () => {
    expect(instance).toMatch(/^\s*copy_tags_to_snapshot\s*=\s*true\s*$/m);
  });

  it('owns the log group RDS writes to, with the 30-day retention the privacy runbook states', () => {
    // Both names come from one local, so renaming the instance moves the log group with it.
    const name = /^\s*name\s*=\s*"\/aws\/rds\/instance\/\$\{local\.db_instance_identifier\}\/postgresql"\s*$/m;
    expect(logGroup).toMatch(name);
    expect(instance).toMatch(/^\s*identifier\s*=\s*local\.db_instance_identifier\s*$/m);
    expect(logGroup).toMatch(/^\s*retention_in_days\s*=\s*30\s*$/m);
    expect(instance).toMatch(/^\s*depends_on\s*=\s*\[[^\]]*aws_cloudwatch_log_group\.rds_postgresql[^\]]*\]/m);
  });

  it('is not forwarded to Datadog (the log stays in the AWS account)', () => {
    expect(stripComments(readFileSync(DATADOG_TF, 'utf8'))).not.toMatch(/rds_postgresql|\/aws\/rds\//);
  });
});

describe('RDS parameter group — extraction self-test', () => {
  const sample = [
    'resource "aws_db_parameter_group" "postgres" {',
    '  parameter {',
    '    name  = "rds.force_ssl"',
    '    value = "1"',
    '  }',
    '  parameter {',
    '    name         = "log_statement"',
    '    value        = "none"',
    '    apply_method = "immediate"',
    '  }',
    '}',
  ].join('\n');

  it('reads every parameter block, with or without apply_method', () => {
    expect([...parameters(sample).entries()]).toEqual([
      ['rds.force_ssl', '1'],
      ['log_statement', 'none'],
    ]);
  });

  it('fails loudly when there is no parameter block, and on a duplicate', () => {
    expect(() => parameters('resource "x" "y" {}')).toThrow(/Read 0 of 0/);
    const twice = sample.replace('"log_statement"', '"rds.force_ssl"');
    expect(() => parameters(twice)).toThrow(/declared twice/);
  });

  it('refuses a block it cannot read (another attribute order), instead of skipping it', () => {
    const reordered = sample.replace(
      '  }\n}',
      '  }\n  parameter {\n    value = "1"\n    name  = "log_duration"\n  }\n}',
    );
    expect(() => parameters(reordered)).toThrow(/Read 2 of 3/);
    const commented = sample.replace('    value = "1"', '    # value = "1"');
    expect(() => parameters(stripComments(commented))).toThrow(/Read 1 of 2/);
  });
});
