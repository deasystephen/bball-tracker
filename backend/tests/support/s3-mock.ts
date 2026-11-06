/**
 * Shared double of `@aws-sdk/client-s3` for suites that reach S3 incidentally,
 * such as the real-database suites that call `AccountService.deleteAccount`
 * (whose avatar cleanup lists and deletes before it returns, #957). There is
 * deliberately no global S3 mock in `tests/setup.ts`: each suite that reaches
 * S3 declares one, so a suite that ought to assert on S3 never passes silently
 * against a stub it did not know about.
 *
 *   const mockS3Send = jest.fn().mockResolvedValue({});
 *   jest.mock('@aws-sdk/client-s3', () =>
 *     jest.requireActual('../support/s3-mock').mockS3ClientModule(
 *       (...args: unknown[]) => mockS3Send(...args)));
 *
 * Each command records `{ kind, input }`, so `mockS3Send.mock.calls` shows
 * what was sent.
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
    DeleteObjectsCommand: command('DeleteObjects'),
    ListObjectsV2Command: command('ListObjectsV2'),
  };
}

/** The commands of one kind that `send` received, in order. */
export function sentOfKind(send: jest.Mock, kind: string): SentS3Command[] {
  return send.mock.calls.map(([cmd]) => cmd as SentS3Command).filter((cmd) => cmd.kind === kind);
}
