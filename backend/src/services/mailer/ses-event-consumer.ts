/**
 * Long-polls the SES events queue and feeds each message to `ses-events.ts`
 * (#449).
 *
 * Why a queue and not an SNS → HTTPS webhook: the API is one task, so a
 * webhook loses events during every deploy and outage once SNS gives up
 * retrying, and it needs a public route plus SNS signature verification. The
 * queue holds events for 14 days, needs no inbound surface, and is authorized
 * by the task role.
 *
 * Delivery contract:
 *   - handled or ignored message → deleted;
 *   - handler threw (database down) or the body is malformed → NOT deleted; it
 *     becomes visible again after the queue's visibility timeout and moves to
 *     the dead-letter queue after the redrive policy's `maxReceiveCount`.
 *
 * Every write in `ses-events.ts` is idempotent, so at-least-once delivery and
 * a second replica polling the same queue are both safe.
 */

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { handleSesEventMessage, SesEventParseError } from './ses-events';

/** SQS maximums: the longest long-poll and the largest batch. */
const WAIT_TIME_SECONDS = 20;
const MAX_MESSAGES = 10;

/** Back-off after a failed receive: 5s doubling to a 60s ceiling. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

export function backoffDelayMs(consecutiveFailures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(consecutiveFailures - 1, 0), BACKOFF_MAX_MS);
}

/** The slice of `SQSClient` the consumer uses, so tests can pass a stub. */
export type SqsLike = Pick<SQSClient, 'send'>;

export interface SesEventConsumerOptions {
  queueUrl: string;
  client: SqsLike;
  /** Injected by tests to skip real back-off waits. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface PollResult {
  received: number;
  deleted: number;
  failed: number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    // Never keep the process alive just to wait out a back-off.
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

export class SesEventConsumer {
  private readonly queueUrl: string;
  private readonly client: SqsLike;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private abortController: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor({ queueUrl, client, sleep }: SesEventConsumerOptions) {
    this.queueUrl = queueUrl;
    this.client = client;
    this.sleep = sleep ?? abortableSleep;
  }

  get isRunning(): boolean {
    return this.abortController !== null;
  }

  /** Start polling in the background. A second call while running is a no-op. */
  start(): void {
    if (this.abortController) return;
    const controller = new AbortController();
    this.abortController = controller;
    this.loop = this.run(controller.signal);
    logger.info('SES event consumer started');
  }

  /** Stop polling; resolves once the in-flight poll has unwound. */
  async stop(): Promise<void> {
    const controller = this.abortController;
    if (!controller) return;
    this.abortController = null;
    controller.abort();
    await this.loop;
    this.loop = null;
    logger.info('SES event consumer stopped');
  }

  /** Receive one batch and process it. Throws when the receive itself fails. */
  async pollOnce(signal?: AbortSignal): Promise<PollResult> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: MAX_MESSAGES,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
      }),
      { abortSignal: signal }
    );

    const messages = response.Messages ?? [];
    const result: PollResult = { received: messages.length, deleted: 0, failed: 0 };
    for (const message of messages) {
      if (await this.process(message)) {
        result.deleted += 1;
      } else {
        result.failed += 1;
      }
    }
    return result;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        consecutiveFailures = 0;
      } catch (error) {
        // Aborting the in-flight long poll rejects it; that is the stop path.
        if (signal.aborted) break;
        consecutiveFailures += 1;
        logger.error('SES event queue poll failed', {
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures,
        });
        // One report per outage, not one per retry.
        if (consecutiveFailures === 1) {
          captureException(error, { flow: 'ses-event-consumer' });
        }
        await this.sleep(backoffDelayMs(consecutiveFailures), signal);
      }
    }
  }

  /** Returns true when the message was handled and deleted. */
  private async process(message: Message): Promise<boolean> {
    try {
      await handleSesEventMessage(message.Body ?? '');
    } catch (error) {
      logger.error('SES event could not be processed; leaving it for redelivery', {
        sqsMessageId: message.MessageId,
        malformed: error instanceof SesEventParseError,
        error: error instanceof Error ? error.message : String(error),
      });
      captureException(error, { flow: 'ses-event-consumer' });
      return false;
    }

    try {
      await this.client.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle })
      );
      return true;
    } catch (error) {
      // The event was applied; a redelivery re-applies it, which is a no-op.
      logger.warn('SES event handled but not deleted; it will be redelivered', {
        sqsMessageId: message.MessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

/**
 * Build the consumer from the environment, or `null` when
 * `SES_EVENTS_QUEUE_URL` is unset (local development, tests, and production
 * until the queue exists) — the API then runs exactly as before.
 */
export function createSesEventConsumer(env: NodeJS.ProcessEnv = process.env): SesEventConsumer | null {
  const queueUrl = env.SES_EVENTS_QUEUE_URL?.trim();
  if (!queueUrl) return null;

  const region = env.AWS_SES_REGION ?? env.AWS_REGION;
  return new SesEventConsumer({ queueUrl, client: new SQSClient({ region }) });
}
