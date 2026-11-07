/**
 * Shared double of `@aws-sdk/client-s3` for suites that run the real
 * `upload-service` against a fake S3. Real S3 is never called from a test.
 *
 *   const mockS3Send = jest.fn().mockResolvedValue({});
 *   jest.mock('@aws-sdk/client-s3', () =>
 *     jest.requireActual('../support/s3-mock').mockS3ClientModule(
 *       (...args: unknown[]) => mockS3Send(...args)));
 *
 * Each command records `{ kind, input }`, so `mockS3Send.mock.calls` shows
 * what was sent; `sentOfKind` filters them.
 */

type Send = (...args: unknown[]) => unknown;

export interface SentS3Command {
  kind: string;
  input: Record<string, unknown>;
}

export function mockS3ClientModule(send: Send): Record<string, unknown> {
  const command = (kind: string): jest.Mock =>
    jest.fn().mockImplementation((input: Record<string, unknown>): SentS3Command => ({ kind, input }));
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send })),
    DeleteObjectCommand: command('DeleteObject'),
    DeleteObjectTaggingCommand: command('DeleteObjectTagging'),
    HeadObjectCommand: command('HeadObject'),
    HeadBucketCommand: command('HeadBucket'),
  };
}

/** The commands of one kind that `send` received, in order. */
export function sentOfKind(send: jest.Mock, kind: string): SentS3Command[] {
  return send.mock.calls.map(([cmd]) => cmd as SentS3Command).filter((cmd) => cmd.kind === kind);
}

/** An SDK-shaped S3 rejection (`name` plus `$metadata.httpStatusCode`). */
export function s3Error(name: string, status: number, message = name): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}
