/**
 * Config-bound test over the public edge: the ALB (`infra/ecs.tf`) and the
 * web ACL in front of it (`infra/waf.tf`), #764.
 *
 * Pinned here because `terraform validate` (the only Terraform CI runs) checks
 * none of it, and each line is a decision a later edit could undo quietly:
 *
 *   - `drop_invalid_header_fields` and production `enable_deletion_protection`
 *     on `aws_lb.main`.
 *   - `enable_waf_fail_open`: the web ACL counts and blocks nothing, so an AWS
 *     WAF outage must not turn into 403s for every request (the ALB default).
 *   - NO access logs: they record full URLs, and this API carries bearer
 *     secrets in URLs (calendar feed tokens, invitation tokens, the OAuth
 *     `code`) that the ALB cannot redact. Turning them on is a privacy-policy
 *     change (docs/runbooks/data-subject-requests.md, "Retention"); change
 *     this test in the same PR as that decision (infra/README.md, "Edge: ALB
 *     and WAF").
 *   - The web ACL keeps nothing request-level: no logging configuration and
 *     sampled requests off on every visibility_config.
 *
 * Every extraction fails loudly when a file changed shape.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { resourceBlock, stripComments } from './terraform';
import { ROOT } from './workflows';

const INFRA = path.join(ROOT, 'infra');
const ECS_TF = path.join(INFRA, 'ecs.tf');
const WAF_TF = path.join(INFRA, 'waf.tf');

/** Every top-level `*.tf` under infra/ (bootstrap/ is its own configuration and has no ALB). */
function infraSources(): string {
  const files = readdirSync(INFRA).filter((f) => f.endsWith('.tf'));
  if (files.length === 0) throw new Error(`No .tf files found under ${INFRA}.`);
  return files.map((f) => stripComments(readFileSync(path.join(INFRA, f), 'utf8'))).join('\n');
}

describe('ALB hardening (aws_lb.main)', () => {
  const alb = resourceBlock(ECS_TF, 'aws_lb', 'main');

  it('drops header fields that are not valid HTTP tokens', () => {
    expect(alb).toMatch(/^\s*drop_invalid_header_fields\s*=\s*true\s*$/m);
  });

  it('enables deletion protection in production, environment-conditional like RDS', () => {
    expect(alb).toMatch(/^\s*enable_deletion_protection\s*=\s*var\.environment\s*==\s*"production"\s*$/m);
  });

  it('fails open when AWS WAF is unreachable', () => {
    expect(alb).toMatch(/^\s*enable_waf_fail_open\s*=\s*true\s*$/m);
  });

  it('writes no access or connection logs (full URLs carry bearer tokens)', () => {
    expect(alb).not.toMatch(/^\s*access_logs\s*\{/m);
    expect(alb).not.toMatch(/^\s*connection_logs\s*\{/m);
  });
});

describe('Web ACL (aws_wafv2_web_acl.alb)', () => {
  const acl = resourceBlock(WAF_TF, 'aws_wafv2_web_acl', 'alb');
  const association = resourceBlock(WAF_TF, 'aws_wafv2_web_acl_association', 'alb');

  it('is regional and associated with the ALB', () => {
    expect(acl).toMatch(/^\s*scope\s*=\s*"REGIONAL"\s*$/m);
    expect(association).toMatch(/^\s*resource_arn\s*=\s*aws_lb\.main\.arn\s*$/m);
    expect(association).toMatch(/^\s*web_acl_arn\s*=\s*aws_wafv2_web_acl\.alb\.arn\s*$/m);
  });

  it('allows by default', () => {
    expect(acl).toMatch(/default_action\s*\{\s*allow\s*\{\s*\}\s*\}/);
  });

  it('keeps no sampled requests on any rule or on the ACL', () => {
    const sampled = [...acl.matchAll(/^\s*sampled_requests_enabled\s*=\s*(\w+)\s*$/gm)].map((m) => m[1]);
    const configs = [...acl.matchAll(/^\s*visibility_config\s*\{/gm)].length;
    expect(configs).toBeGreaterThan(0);
    expect(sampled).toHaveLength(configs);
    expect(new Set(sampled)).toEqual(new Set(['false']));
  });

  it('has no WAF logging configuration anywhere in infra/', () => {
    expect(infraSources()).not.toMatch(/resource\s+"aws_wafv2_web_acl_logging_configuration"/);
  });
});
