/**
 * Config-bound test over Terraform's `prevent_destroy` guards (#754).
 *
 * The hooplings.com hosted zone was created by Amazon Registrar with live NS
 * delegation and IMPORTED into Terraform. Destroying or re-creating it gives
 * the domain a zone the registrar does not point at: `api.hooplings.com`, SES
 * DKIM / MAIL FROM and the Google Workspace mail records all stop resolving
 * (the capyhoops.com twin-zone split). Route53's "zone not empty" refusal does
 * not help, because every record in the zone is a Terraform-managed child that
 * Terraform deletes first.
 *
 * `lifecycle { prevent_destroy = true }` makes `terraform plan` refuse the
 * destroy. CI never runs Terraform, so this suite is what keeps the line from
 * being dropped in an unrelated edit. Every extraction must succeed: a file
 * that changed shape fails loudly rather than passing vacuously.
 *
 * `aws_db_instance.main` deliberately carries NO `prevent_destroy`: the RDS
 * restore runbook (docs/runbooks/rds-backup-restore.md) renames and imports the
 * instance, and `deletion_protection` is already enforced by AWS at apply time.
 */
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const DNS_TF = path.join(ROOT, 'infra/dns.tf');
const S3_TF = path.join(ROOT, 'infra/s3.tf');
const RDS_TF = path.join(ROOT, 'infra/rds.tf');

/** Removes whole-line `#` and `//` comments so commented-out code never counts. */
export function stripLineComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

/** Returns the text between the `{` that ends `header` and its matching `}`. */
function braceBody(code: string, header: RegExpExecArray, what: string): string {
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    if (code[i] === '}') depth -= 1;
    if (depth === 0) return code.slice(start, i);
  }
  throw new Error(`${what} has no closing brace.`);
}

/** Returns the brace-matched body of `<kind> "<type>" "<name>" { … }`. */
export function extractBlock(source: string, kind: string, type: string, name: string, label: string): string {
  const code = stripLineComments(source);
  const header = new RegExp(`^${kind}\\s+"${type}"\\s+"${name}"\\s*\\{`, 'm').exec(code);
  if (!header) {
    throw new Error(
      `${label}: could not find ${kind} "${type}" "${name}". If the file changed shape, update ` +
        'tests/infra/prevent-destroy.test.ts — do not let this test pass vacuously.',
    );
  }
  return braceBody(code, header, `${label}: ${kind} "${type}" "${name}"`);
}

/** True when the block has a `lifecycle { … prevent_destroy = true … }` sub-block. */
export function hasPreventDestroy(block: string, label: string): boolean {
  const header = /^\s*lifecycle\s*\{/m.exec(block);
  if (!header) return false;
  const lifecycle = braceBody(block, header, `${label} lifecycle`);
  return /^\s*prevent_destroy\s*=\s*true\s*$/m.test(lifecycle);
}

function resourceBlock(file: string, type: string, name: string): string {
  const label = `${path.relative(ROOT, file)} resource "${type}" "${name}"`;
  return extractBlock(readFileSync(file, 'utf8'), 'resource', type, name, label);
}

describe('Terraform prevent_destroy guards', () => {
  it('refuses to destroy the Route53 hosted zones (aws_route53_zone.main)', () => {
    const block = resourceBlock(DNS_TF, 'aws_route53_zone', 'main');
    expect(hasPreventDestroy(block, 'aws_route53_zone.main')).toBe(true);
  });

  it('refuses to destroy the avatars bucket (aws_s3_bucket.avatars)', () => {
    const block = resourceBlock(S3_TF, 'aws_s3_bucket', 'avatars');
    expect(hasPreventDestroy(block, 'aws_s3_bucket.avatars')).toBe(true);
  });

  it('leaves the RDS instance to deletion_protection, so the restore runbook can rename and import it', () => {
    const block = resourceBlock(RDS_TF, 'aws_db_instance', 'main');
    expect(hasPreventDestroy(block, 'aws_db_instance.main')).toBe(false);
    expect(block).toMatch(/^\s*deletion_protection\s*=/m);
  });
});

describe('Terraform prevent_destroy guards — extraction self-test', () => {
  const guarded = [
    'resource "aws_route53_zone" "main" {',
    '  name = each.key',
    '  tags = {',
    '    Name = "${local.name_prefix}-dns-${each.key}"',
    '  }',
    '  lifecycle {',
    '    prevent_destroy = true',
    '  }',
    '}',
    'resource "aws_acm_certificate" "main" {',
    '  lifecycle {',
    '    create_before_destroy = true',
    '  }',
    '}',
  ].join('\n');

  it('finds the guard inside the named resource only', () => {
    expect(hasPreventDestroy(extractBlock(guarded, 'resource', 'aws_route53_zone', 'main', 't'), 't')).toBe(true);
    expect(hasPreventDestroy(extractBlock(guarded, 'resource', 'aws_acm_certificate', 'main', 't'), 't')).toBe(false);
  });

  it('goes red when the prevent_destroy line is removed or commented out', () => {
    const removed = guarded.replace('    prevent_destroy = true\n', '');
    const commented = guarded.replace('    prevent_destroy = true', '    # prevent_destroy = true');
    const disabled = guarded.replace('prevent_destroy = true', 'prevent_destroy = false');
    for (const source of [removed, commented, disabled]) {
      expect(hasPreventDestroy(extractBlock(source, 'resource', 'aws_route53_zone', 'main', 't'), 't')).toBe(false);
    }
  });

  it('fails loudly when the resource block cannot be found', () => {
    expect(() => extractBlock(guarded, 'resource', 'aws_route53_zone', 'primary', 't')).toThrow(/could not find/);
    expect(() =>
      extractBlock('# resource "aws_route53_zone" "main" {', 'resource', 'aws_route53_zone', 'main', 't'),
    ).toThrow(/could not find/);
    expect(() =>
      extractBlock('resource "aws_route53_zone" "main" {\n  name = "x"\n', 'resource', 'aws_route53_zone', 'main', 't'),
    ).toThrow(/no closing brace/);
  });
});
