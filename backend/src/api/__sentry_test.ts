/**
 * Temporary smoke-test route for verifying Sentry end-to-end.
 *
 * Hit it with a valid JWT:
 *   curl -H "Authorization: Bearer <jwt>" https://api.capyhoops.com/api/v1/__sentry_test
 *
 * Should return 500 and produce a Sentry event with:
 * - message "sentry smoke test — ignore me"
 * - release tag = git SHA
 * - user.id tag populated
 * - Authorization header scrubbed to [scrubbed]
 *
 * REMOVE THIS FILE once Sentry is confirmed live. Tracked informally;
 * the commit that adds it should be reverted once the smoke test passes.
 */
import { Router } from 'express';
import { authenticate } from './auth/middleware';

const router = Router();

router.get('/__sentry_test', authenticate, () => {
  throw new Error('sentry smoke test — ignore me');
});

export default router;
