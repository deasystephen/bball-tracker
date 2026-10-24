/**
 * Config-bound test over the Datadog log forwarding in `infra/datadog.tf`
 * (#966). What it pins, each a decision a later edit could undo quietly
 * (`terraform validate`, the only Terraform CI runs, checks none of it):
 *
 *   - The API's log group is forwarded whole; the web site's only through a
 *     JSON filter on `service`, and that value is the one `web/lib/log.ts`
 *     writes. Next.js's free-text output, which could quote an invitation URL,
 *     never leaves CloudWatch.
 *   - Each subscription has its own Lambda permission scoped to its own log
 *     group.
 *   - The forwarder tags every line `env:<environment>` (`DdTags`).
 *   - The forwarder template is pinned to a version (a parameter change with
 *     `latest.yaml` silently upgrades the Lambda), and the subscriptions take
 *     the function ARN from its name, not the stack outputs (which go unknown
 *     on any stack update and force-replace every subscription).
 */
import { readFileSync } from 'fs';
import path from 'path';
import { resourceBlock } from './terraform';
import { ROOT } from './workflows';

const DATADOG_TF = path.join(ROOT, 'infra/datadog.tf');
const WEB_LOGGER = readFileSync(path.join(ROOT, 'web/lib/log.ts'), 'utf8');
const API_LOGGER = readFileSync(path.join(ROOT, 'backend/src/utils/logger.ts'), 'utf8');

function attribute(block: string, name: string): string {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(block);
  if (!match) throw new Error(`infra/datadog.tf: attribute \`${name}\` not found in the block.`);
  return match[1];
}

function serviceConstant(source: string, label: string): string {
  const match = /export const LOG_SERVICE = '([^']+)';/.exec(source);
  if (!match) throw new Error(`${label}: \`export const LOG_SERVICE = '…'\` not found.`);
  return match[1];
}

describe('Datadog log forwarding (infra/datadog.tf, #966)', () => {
  const stack = resourceBlock(DATADOG_TF, 'aws_cloudformation_stack', 'datadog_forwarder');
  const apiFilter = resourceBlock(DATADOG_TF, 'aws_cloudwatch_log_subscription_filter', 'datadog');
  const webFilter = resourceBlock(DATADOG_TF, 'aws_cloudwatch_log_subscription_filter', 'datadog_web');
  const apiPermission = resourceBlock(DATADOG_TF, 'aws_lambda_permission', 'allow_cloudwatch');
  const webPermission = resourceBlock(DATADOG_TF, 'aws_lambda_permission', 'allow_cloudwatch_web');

  it('forwards every line of the API log group', () => {
    expect(attribute(apiFilter, 'log_group_name')).toBe('aws_cloudwatch_log_group.app.name');
    expect(attribute(apiFilter, 'filter_pattern')).toBe('""');
  });

  it("forwards only the web logger's JSON lines from the web log group", () => {
    const service = serviceConstant(WEB_LOGGER, 'web/lib/log.ts');
    expect(service).toBe('bball-tracker-web');
    expect(attribute(webFilter, 'log_group_name')).toBe('aws_cloudwatch_log_group.web.name');
    expect(attribute(webFilter, 'filter_pattern')).toBe(`"{ $.service = \\"${service}\\" }"`);
  });

  it('keeps the two services distinct, so the web filter can never match an API line', () => {
    expect(serviceConstant(API_LOGGER, 'backend/src/utils/logger.ts')).toBe('bball-tracker-api');
  });

  it('scopes each Lambda permission to its own log group, under the same count gate', () => {
    expect(attribute(apiPermission, 'source_arn')).toBe('"${aws_cloudwatch_log_group.app.arn}:*"');
    expect(attribute(webPermission, 'source_arn')).toBe('"${aws_cloudwatch_log_group.web.arn}:*"');
    expect(attribute(apiPermission, 'statement_id')).not.toBe(attribute(webPermission, 'statement_id'));
    for (const block of [apiPermission, webPermission, apiFilter, webFilter, stack]) {
      expect(attribute(block, 'count')).toBe('var.datadog_api_key != "" ? 1 : 0');
    }
    expect(attribute(apiFilter, 'depends_on')).toBe('[aws_lambda_permission.allow_cloudwatch]');
    expect(attribute(webFilter, 'depends_on')).toBe('[aws_lambda_permission.allow_cloudwatch_web]');
  });

  it('tags every forwarded line with env', () => {
    expect(attribute(stack, 'DdTags')).toBe('"env:${var.environment}"');
  });

  it('pins the forwarder template and never reads the function ARN from the stack outputs', () => {
    expect(attribute(stack, 'template_url')).toBe(
      '"https://datadog-cloudformation-template.s3.amazonaws.com/aws/forwarder/${local.datadog_forwarder_version}.yaml"'
    );
    expect(readFileSync(DATADOG_TF, 'utf8')).toMatch(/^\s*datadog_forwarder_version = "\d+\.\d+\.\d+"$/m);
    for (const block of [apiPermission, webPermission]) {
      expect(attribute(block, 'function_name')).toBe('local.datadog_forwarder_arn');
    }
    for (const block of [apiFilter, webFilter]) {
      expect(attribute(block, 'destination_arn')).toBe('local.datadog_forwarder_arn');
    }
    expect(attribute(stack, 'FunctionName')).toBe('local.datadog_forwarder_name');
  });
});
