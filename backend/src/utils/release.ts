/**
 * The commit this process was built from (#570).
 *
 * The deploy job writes the commit into the task definition as
 * `SENTRY_RELEASE` (it replaces `SENTRY_RELEASE_PLACEHOLDER` in
 * `infra/task-definition.json`) and tags the image with the same value, so the
 * variable names the code that is running. `/health` returns it, which makes
 * "what is in production" one request with no AWS access:
 *
 *   curl -s https://api.hooplings.com/health
 *
 * Only a full commit id is returned. Anything else (unset in development, the
 * placeholder left in place, a hand-written release name) reads as `null`, so
 * a caller never compares against a value that is not a commit.
 */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function deployedCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SENTRY_RELEASE?.trim();
  return raw !== undefined && COMMIT_PATTERN.test(raw) ? raw : null;
}
