/**
 * SES event queue consumer (#449): what gets deleted, what is left for
 * redelivery, and how the polling loop starts, backs off and stops.
 *
 * The SQS client is a stub passed through the constructor; `ses-events` is
 * mocked so these tests are about the queue contract, not event handling.
 */

import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import {
  backoffDelayMs,
  createSesEventConsumer,
  SesEventConsumer,
  type SqsLike,
} from '../../src/services/mailer/ses-event-consumer';
import { handleSesEventMessage, SesEventParseError } from '../../src/services/mailer/ses-events';
import { logger } from '../../src/utils/logger';
import { captureException } from '../../src/utils/sentry';

jest.mock('../../src/services/mailer/ses-events', () => {
  const actual = jest.requireActual<typeof import('../../src/services/mailer/ses-events')>(
    '../../src/services/mailer/ses-events'
  );
  return { ...actual, handleSesEventMessage: jest.fn() };
});

jest.mock('../../src/utils/sentry', () => ({ captureException: jest.fn() }));

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/ses-events';
const mockedHandle = handleSesEventMessage as jest.Mock;
const mockedCapture = captureException as jest.Mock;

type SendArgs = [command: unknown, options?: { abortSignal?: AbortSignal }];

function stubClient(send: jest.Mock): SqsLike {
  return { send } as unknown as SqsLike;
}

function message(id: string, body = '{"eventType":"Bounce"}'): Record<string, string> {
  return { MessageId: id, ReceiptHandle: `receipt-${id}`, Body: body };
}

/** A receive that blocks like a real long poll until its abort signal fires. */
function blockUntilAborted(_command: unknown, options?: { abortSignal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    options?.abortSignal?.addEventListener('abort', () => reject(new Error('Request aborted')));
  });
}

function deletedReceipts(send: jest.Mock): unknown[] {
  return (send.mock.calls as SendArgs[])
    .map(([command]) => command)
    .filter((command): command is DeleteMessageCommand => command instanceof DeleteMessageCommand)
    .map((command) => command.input.ReceiptHandle);
}

describe('SesEventConsumer', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedHandle.mockReset();
    mockedHandle.mockResolvedValue({ kind: 'ignored' });
    mockedCapture.mockReset();
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  describe('pollOnce', () => {
    it('long-polls for a full batch', async () => {
      const send = jest.fn().mockResolvedValue({});
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await expect(consumer.pollOnce()).resolves.toEqual({ received: 0, deleted: 0, failed: 0 });

      const [command] = send.mock.calls[0] as SendArgs;
      expect(command).toBeInstanceOf(ReceiveMessageCommand);
      expect((command as ReceiveMessageCommand).input).toEqual({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      });
    });

    it('hands each body to the handler and deletes what was handled', async () => {
      const send = jest
        .fn()
        .mockResolvedValueOnce({ Messages: [message('1', 'body-1'), message('2', 'body-2')] })
        .mockResolvedValue({});
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await expect(consumer.pollOnce()).resolves.toEqual({ received: 2, deleted: 2, failed: 0 });

      expect(mockedHandle.mock.calls).toEqual([['body-1'], ['body-2']]);
      expect(deletedReceipts(send)).toEqual(['receipt-1', 'receipt-2']);
    });

    it('leaves a message the handler failed on, and still processes the rest of the batch', async () => {
      const send = jest
        .fn()
        .mockResolvedValueOnce({ Messages: [message('1'), message('2')] })
        .mockResolvedValue({});
      mockedHandle.mockRejectedValueOnce(new Error('connection refused'));
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await expect(consumer.pollOnce()).resolves.toEqual({ received: 2, deleted: 1, failed: 1 });

      expect(deletedReceipts(send)).toEqual(['receipt-2']);
      expect(errorSpy).toHaveBeenCalledWith(
        'SES event could not be processed; leaving it for redelivery',
        { sqsMessageId: '1', malformed: false, error: 'connection refused' }
      );
      expect(mockedCapture).toHaveBeenCalledWith(expect.any(Error), { flow: 'ses-event-consumer' });
    });

    it('leaves a malformed message too, so it reaches the dead-letter queue intact', async () => {
      const send = jest.fn().mockResolvedValueOnce({ Messages: [message('1')] });
      mockedHandle.mockRejectedValueOnce(new SesEventParseError('Message has no eventType'));
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await expect(consumer.pollOnce()).resolves.toEqual({ received: 1, deleted: 0, failed: 1 });

      expect(deletedReceipts(send)).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ malformed: true })
      );
    });

    it('passes an empty string for a message with no body, and reports a non-Error throw', async () => {
      const send = jest.fn().mockResolvedValueOnce({ Messages: [{ MessageId: '1', ReceiptHandle: 'r' }] });
      mockedHandle.mockRejectedValueOnce('nope');
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await consumer.pollOnce();

      expect(mockedHandle).toHaveBeenCalledWith('');
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'nope' }));
    });

    it.each([
      ['an Error', new Error('AccessDenied'), 'AccessDenied'],
      ['a non-Error', 'throttled', 'throttled'],
    ])('counts a handled message whose delete failed with %s as not deleted', async (_label, failure, text) => {
      const send = jest
        .fn()
        .mockResolvedValueOnce({ Messages: [message('1')] })
        .mockRejectedValueOnce(failure);
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await expect(consumer.pollOnce()).resolves.toEqual({ received: 1, deleted: 0, failed: 1 });

      expect(warnSpy).toHaveBeenCalledWith(
        'SES event handled but not deleted; it will be redelivered',
        { sqsMessageId: '1', error: text }
      );
    });

    it('throws when the receive itself fails', async () => {
      const send = jest.fn().mockRejectedValue(new Error('queue does not exist'));
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await expect(consumer.pollOnce()).rejects.toThrow('queue does not exist');
    });
  });

  describe('start / stop', () => {
    it('polls until stopped, aborting the in-flight long poll', async () => {
      const send = jest
        .fn()
        .mockResolvedValueOnce({ Messages: [message('1')] })
        .mockResolvedValueOnce({})
        .mockImplementation(blockUntilAborted);
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      consumer.start();
      expect(consumer.isRunning).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));

      await consumer.stop();

      expect(consumer.isRunning).toBe(false);
      expect(mockedHandle).toHaveBeenCalledTimes(1);
      // Stopping is not a failure.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(mockedCapture).not.toHaveBeenCalled();
    });

    it('is idempotent in both directions', async () => {
      const send = jest.fn().mockImplementation(blockUntilAborted);
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

      await consumer.stop();
      consumer.start();
      consumer.start();
      await new Promise((resolve) => setImmediate(resolve));
      await consumer.stop();
      await consumer.stop();

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('backs off after failed polls, reports the outage once, and recovers', async () => {
      const send = jest
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockRejectedValueOnce('still down')
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('down again'))
        .mockImplementation(blockUntilAborted);
      const sleep = jest.fn().mockResolvedValue(undefined);
      const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send), sleep });

      consumer.start();
      await new Promise((resolve) => setImmediate(resolve));
      await consumer.stop();

      // 5s, 10s, then — the streak reset by a good poll — 5s again.
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 10_000, 5_000]);
      expect(errorSpy).toHaveBeenCalledWith('SES event queue poll failed', {
        error: 'still down',
        consecutiveFailures: 2,
      });
      // One report per outage, not one per retry.
      expect(mockedCapture).toHaveBeenCalledTimes(2);
    });

    it('waits out a back-off with a real timer when no sleep is injected, and stop() cuts it short', async () => {
      jest.useFakeTimers();
      try {
        const send = jest.fn().mockRejectedValue(new Error('network down'));
        const consumer = new SesEventConsumer({ queueUrl: QUEUE_URL, client: stubClient(send) });

        consumer.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(4_999);
        expect(send).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(send).toHaveBeenCalledTimes(2);

        // Now inside the 10s back-off: stop must not wait for it.
        await consumer.stop();
        expect(send).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

describe('backoffDelayMs', () => {
  it('doubles from 5s and is capped at 60s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(backoffDelayMs)).toEqual([
      5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });
});

describe('createSesEventConsumer', () => {
  it.each([
    ['unset', {}],
    ['blank', { SES_EVENTS_QUEUE_URL: '   ' }],
  ])('returns null when SES_EVENTS_QUEUE_URL is %s, so the API runs as before', (_label, env) => {
    expect(createSesEventConsumer(env)).toBeNull();
  });

  it.each([
    ['the SES region', { AWS_SES_REGION: 'us-east-1' }],
    ['the task region', { AWS_REGION: 'us-east-1' }],
  ])('builds a stopped consumer using %s', (_label, region) => {
    const consumer = createSesEventConsumer({ SES_EVENTS_QUEUE_URL: ` ${QUEUE_URL} `, ...region });

    expect(consumer).toBeInstanceOf(SesEventConsumer);
    expect(consumer?.isRunning).toBe(false);
  });

  it('reads process.env by default', () => {
    expect(process.env.SES_EVENTS_QUEUE_URL).toBeUndefined();
    expect(createSesEventConsumer()).toBeNull();
  });
});
