/**
 * Config-bound test over Terraform's `prevent_destroy` guard (#754).
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
 * destroy. CI runs `terraform fmt`, `init` and `validate` but never `plan` or
 * `apply`, and `validate` does not evaluate `prevent_destroy`, so this suite
 * is what keeps the line from being dropped in an unrelated edit. Every
 * extraction must succeed: a file that changed shape fails loudly rather than
 * passing vacuously.
 *
 * Deliberately unguarded:
 *   - `aws_db_instance.main`: the RDS restore runbook
 *     (docs/runbooks/rds-backup-restore.md) renames and imports the instance,
 *     and AWS enforces `deletion_protection` at apply time.
 *   - `aws_s3_bucket.avatars`: `prevent_destroy` cannot depend on
 *     `var.environment`, so it would block tearing down a staging stack, and
 *     AWS already refuses to delete a non-empty bucket (`force_destroy = false`).
 */
import { readFileSync } from 'fs';
import path from 'path';
import { extractBlock, hasPreventDestroy, stripComments } from './terraform';
import { ROOT } from './workflows';

const DNS_TF = path.join(ROOT, 'infra/dns.tf');
const S3_TF = path.join(ROOT, 'infra/s3.tf');
const RDS_TF = path.join(ROOT, 'infra/rds.tf');
const BOOTSTRAP_TF = path.join(ROOT, 'infra/bootstrap/main.tf');

function resourceBlock(file: string, type: string, name: string): string {
  const label = `${path.relative(ROOT, file)} resource "${type}" "${name}"`;
  return extractBlock(readFileSync(file, 'utf8'), 'resource', type, name, label);
}

describe('Terraform prevent_destroy guards', () => {
  it('refuses to destroy the Route53 hosted zones (aws_route53_zone.main)', () => {
    const block = resourceBlock(DNS_TF, 'aws_route53_zone', 'main');
    expect(hasPreventDestroy(block, 'aws_route53_zone.main')).toBe(true);
  });

  it('leaves the RDS instance to deletion_protection, so the restore runbook can rename and import it', () => {
    const block = resourceBlock(RDS_TF, 'aws_db_instance', 'main');
    expect(hasPreventDestroy(block, 'aws_db_instance.main')).toBe(false);
    expect(block).toMatch(/^\s*deletion_protection\s*=/m);
  });

  it('leaves the avatars bucket destroyable when empty, so a staging stack can be torn down', () => {
    const block = resourceBlock(S3_TF, 'aws_s3_bucket', 'avatars');
    expect(hasPreventDestroy(block, 'aws_s3_bucket.avatars')).toBe(false);
  });

  // The remote-state bucket holds every production credential in plaintext and
  // the lock table serializes every apply (#641, infra/README.md "Remote state").
  it('refuses to destroy the Terraform state bucket (aws_s3_bucket.state)', () => {
    const block = resourceBlock(BOOTSTRAP_TF, 'aws_s3_bucket', 'state');
    expect(hasPreventDestroy(block, 'aws_s3_bucket.state')).toBe(true);
  });

  it('refuses to destroy the Terraform lock table (aws_dynamodb_table.locks)', () => {
    const block = resourceBlock(BOOTSTRAP_TF, 'aws_dynamodb_table', 'locks');
    expect(hasPreventDestroy(block, 'aws_dynamodb_table.locks')).toBe(true);
    expect(block).toMatch(/^\s*deletion_protection_enabled\s*=\s*true/m);
  });
});

describe('Terraform prevent_destroy guards — extraction self-test', () => {
  const guarded = [
    'resource "aws_route53_zone" "main" {',
    '  name = each.key',
    '  tags = {',
    '    Name = "${local.name_prefix}-dns-${each.key}"',
    '    Note = "a { brace, a # hash and a // slash inside a string"',
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
  const zone = (source: string): string => extractBlock(source, 'resource', 'aws_route53_zone', 'main', 't');

  it('finds the guard inside the named resource only', () => {
    expect(hasPreventDestroy(zone(guarded), 't')).toBe(true);
    expect(hasPreventDestroy(extractBlock(guarded, 'resource', 'aws_acm_certificate', 'main', 't'), 't')).toBe(false);
  });

  it('accepts a trailing comment on the guard line, even one with an unbalanced brace', () => {
    for (const comment of ['# #754', '// keep {', '/* } */']) {
      const source = guarded.replace('prevent_destroy = true', `prevent_destroy = true ${comment}`);
      expect(hasPreventDestroy(zone(source), 't')).toBe(true);
    }
  });

  it('goes red when the prevent_destroy line is removed, commented out or disabled', () => {
    const removed = guarded.replace('    prevent_destroy = true\n', '');
    const hashed = guarded.replace('    prevent_destroy = true', '    # prevent_destroy = true');
    const slashed = guarded.replace('    prevent_destroy = true', '    // prevent_destroy = true');
    const disabled = guarded.replace('prevent_destroy = true', 'prevent_destroy = false');
    for (const source of [removed, hashed, slashed, disabled]) {
      expect(hasPreventDestroy(zone(source), 't')).toBe(false);
    }
  });

  it('fails loudly when the resource block cannot be found', () => {
    expect(() => extractBlock(guarded, 'resource', 'aws_route53_zone', 'primary', 't')).toThrow(/could not find/);
    expect(() => zone('# resource "aws_route53_zone" "main" {')).toThrow(/could not find/);
    expect(() => zone('resource "aws_route53_zone" "main" {\n  name = "x"\n')).toThrow(/no closing brace/);
  });

  it('blanks comments outside strings and keeps strings and heredocs intact', () => {
    const source = [
      'a = "https://x.test/#anchor" # gone',
      'b = "${var.x == "y" ? "#" : "//"}" // gone',
      'c = <<-EOF',
      '  # kept { inside the heredoc',
      '  EOF',
      '/* gone */ d = 1',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toContain('"https://x.test/#anchor"');
    expect(stripped).toContain('"${var.x == "y" ? "#" : "//"}"');
    expect(stripped).toContain('# kept { inside the heredoc');
    expect(stripped).not.toContain('gone');
    expect(stripped.split('\n')).toHaveLength(6);
  });
});
