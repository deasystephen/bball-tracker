/**
 * Config-bound test over the SES event pipeline (#449).
 *
 * The pipeline is declared in two machine-consumed files that cannot share a
 * constant:
 *
 *   - `infra/ses-events.tf`        — the configuration set, the queue, what is published
 *   - `infra/task-definition.json` — the names the API is told to use
 *
 * A mismatch fails quietly and in production only: a wrong configuration set
 * name makes every send fail (invitations are created, no email leaves), a
 * wrong queue URL means no bounce is ever recorded. Every extraction below
 * must succeed — a file that changed shape fails loudly rather than letting
 * the suite pass vacuously.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { createSesEventConsumer, SesEventConsumer } from '../../src/services/mailer/ses-event-consumer';

const ROOT = path.resolve(__dirname, '../../..');
const SES_EVENTS_TF = path.join(ROOT, 'infra/ses-events.tf');
const SES_TF = path.join(ROOT, 'infra/ses.tf');
const TASK_DEFINITION = path.join(ROOT, 'infra/task-definition.json');

interface TaskDefinition {
  family: string;
  taskRoleArn: string;
  containerDefinitions: Array<{ environment?: Array<{ name: string; value: string }> }>;
}

const taskDefinition = JSON.parse(readFileSync(TASK_DEFINITION, 'utf8')) as TaskDefinition;
const env = new Map(
  taskDefinition.containerDefinitions.flatMap((c) => c.environment ?? []).map((e) => [e.name, e.value])
);
const sesEventsTf = readFileSync(SES_EVENTS_TF, 'utf8');
const sesTf = readFileSync(SES_TF, 'utf8');

function get(name: string): string {
  const value = env.get(name);
  if (value === undefined) throw new Error(`${name} is missing from ${TASK_DEFINITION}`);
  return value;
}

/** Returns the body of `<kind> "<type>" "<name>" { … }`, brace-matched. */
function extractBlock(source: string, kind: string, type: string, name: string, label: string): string {
  const header = new RegExp(`^${kind}\\s+"${type}"\\s+"${name}"\\s*\\{`, 'm').exec(source);
  if (!header) {
    throw new Error(
      `${label}: could not find ${kind} "${type}" "${name}". If the file changed shape, update ` +
        'tests/infra/ses-events.test.ts — do not let this test pass vacuously.'
    );
  }
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i);
  }
  throw new Error(`${label}: ${kind} "${type}" "${name}" has no closing brace.`);
}

/** Resolves `attribute = "${local.name_prefix}<suffix>"` against the deployed prefix. */
function resolveName(block: string, attribute: string, label: string): string {
  const match = new RegExp(`^\\s*${attribute}\\s*=\\s*"\\$\\{local\\.name_prefix\\}([^"]+)"\\s*$`, 'm').exec(block);
  if (!match) {
    throw new Error(`${label}: could not find \`${attribute} = "\${local.name_prefix}…"\`.`);
  }
  return `${namePrefix()}${match[1]}`;
}

/** `local.name_prefix` as production runs it: the task family without its `-api` suffix. */
function namePrefix(): string {
  const match = /^(.+)-api$/.exec(taskDefinition.family);
  if (!match) throw new Error(`Task family "${taskDefinition.family}" does not end in -api.`);
  return match[1];
}

function accountId(): string {
  const match = /^arn:aws:iam::(\d{12}):role\//.exec(taskDefinition.taskRoleArn);
  if (!match) throw new Error(`taskRoleArn "${taskDefinition.taskRoleArn}" carries no account id.`);
  return match[1];
}

describe('SES event pipeline — Terraform and the deploy file agree', () => {
  it('SES_CONFIGURATION_SET names the configuration set Terraform creates', () => {
    const block = extractBlock(sesEventsTf, 'resource', 'aws_sesv2_configuration_set', 'transactional', 'ses-events.tf');

    expect(get('SES_CONFIGURATION_SET')).toBe(resolveName(block, 'configuration_set_name', 'configuration set'));
  });

  it('SES_EVENTS_QUEUE_URL is the URL of the queue Terraform creates, in the SES region', () => {
    const block = extractBlock(sesEventsTf, 'resource', 'aws_sqs_queue', 'ses_events', 'ses-events.tf');
    const queueName = resolveName(block, 'name', 'ses_events queue');

    expect(get('SES_EVENTS_QUEUE_URL')).toBe(
      `https://sqs.${get('AWS_SES_REGION')}.amazonaws.com/${accountId()}/${queueName}`
    );
  });

  it('points the API at the queue, never at its dead-letter queue', () => {
    const dlq = extractBlock(sesEventsTf, 'resource', 'aws_sqs_queue', 'ses_events_dlq', 'ses-events.tf');

    expect(get('SES_EVENTS_QUEUE_URL').endsWith(`/${resolveName(dlq, 'name', 'dead-letter queue')}`)).toBe(false);
  });

  it('starts the consumer from the production environment block', () => {
    const consumer = createSesEventConsumer(Object.fromEntries(env));

    expect(consumer).toBeInstanceOf(SesEventConsumer);
  });

  it('the send policy covers the configuration set, or every send is AccessDenied', () => {
    // SendEmail with a ConfigurationSetName is authorized against the set's ARN
    // as well as the identity's.
    const policy = extractBlock(sesTf, 'data', 'aws_iam_policy_document', 'ses_send', 'ses.tf');

    expect(policy).toContain('aws_sesv2_configuration_set.transactional.arn');
    expect(policy).toMatch(/identity\/\*/);
  });

  it('publishes every event type the handler acts on', () => {
    const match = /^\s*ses_published_event_types\s*=\s*\[([^\]]+)\]/m.exec(sesEventsTf);
    if (!match) throw new Error('ses-events.tf: could not find local.ses_published_event_types.');
    const published = match[1].split(',').map((entry) => entry.trim().replace(/"/g, ''));

    // DELIVERY is what clears a recorded bounce; without it a flag never heals.
    expect([...published].sort()).toEqual(['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT']);

    const destination = extractBlock(
      sesEventsTf,
      'resource',
      'aws_sesv2_configuration_set_event_destination',
      'sns',
      'ses-events.tf'
    );
    expect(destination).toMatch(/matching_event_types\s*=\s*local\.ses_published_event_types/);
  });

  it('delivers raw messages to a queue with a dead-letter queue behind it', () => {
    const subscription = extractBlock(sesEventsTf, 'resource', 'aws_sns_topic_subscription', 'ses_events_queue', 'ses-events.tf');
    const queue = extractBlock(sesEventsTf, 'resource', 'aws_sqs_queue', 'ses_events', 'ses-events.tf');

    expect(subscription).toMatch(/raw_message_delivery\s*=\s*true/);
    expect(queue).toContain('aws_sqs_queue.ses_events_dlq.arn');
    expect(queue).toMatch(/maxReceiveCount\s*=\s*\d+/);
  });
});
