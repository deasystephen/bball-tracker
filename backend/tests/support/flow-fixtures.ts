/**
 * What the Maestro flows create, as far as the seed has to know (#584).
 *
 * `npx prisma db seed` is the reset between flows. It can only remove what it
 * has been told about, so this list and the flows must agree;
 * `tests/support/flow-fixtures.test.ts` reads `.maestro/` and fails when a flow
 * creates a game whose opponent is not listed here.
 */

/** Opponent names the flows type on the Create Game screen. */
export const FLOW_CREATED_OPPONENTS = [
  'Test Rival', // game-lifecycle.yaml
  'Tracking Rival', // game-tracking.yaml
  'Spectator Rival', // live-spectator.yaml
  'Fixture Rival', // coach-onboarding.yaml (also removed with Dana's teams)
];

/**
 * Announcement titles the flows post (announcement-reply.yaml). The seed
 * deletes them by title; replies go with them (cascade).
 */
export const FLOW_CREATED_ANNOUNCEMENT_TITLES = [
  'Reply Fixture', // announcement-reply.yaml
];
