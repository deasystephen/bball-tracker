/**
 * Unit tests for the shared resend cooldown (#715 team, #420 guardian).
 */

import { assertResendCooldown, INVITATION_RESEND_COOLDOWN_MS } from '../../src/utils/resend-cooldown';
import { ResendCooldownError } from '../../src/utils/errors';

describe('assertResendCooldown', () => {
  it('is a two-minute window', () => {
    expect(INVITATION_RESEND_COOLDOWN_MS).toBe(2 * 60 * 1000);
  });

  it.each([null, undefined])('never refuses when there is no prior row (%s)', (latest) => {
    const onRefused = jest.fn();
    expect(() => assertResendCooldown(latest, INVITATION_RESEND_COOLDOWN_MS, 'player', onRefused)).not.toThrow();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('allows a resend once the window has passed', () => {
    const latest = new Date(Date.now() - INVITATION_RESEND_COOLDOWN_MS - 1000);
    expect(() => assertResendCooldown(latest, INVITATION_RESEND_COOLDOWN_MS, 'player')).not.toThrow();
  });

  it('refuses inside the window with 429, the seconds left, and the recipient word', () => {
    const onRefused = jest.fn();
    const latest = new Date(Date.now() - 30_000);

    let err: unknown;
    try {
      assertResendCooldown(latest, INVITATION_RESEND_COOLDOWN_MS, 'address', onRefused);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ResendCooldownError);
    const refusal = err as ResendCooldownError;
    expect(refusal.statusCode).toBe(429);
    const { retryAfterSeconds } = refusal.body();
    expect(retryAfterSeconds).toBeGreaterThan(80);
    expect(retryAfterSeconds).toBeLessThanOrEqual(90);
    expect(refusal.message).toBe(`An invitation was just sent to this address. Try again in ${retryAfterSeconds} seconds.`);
    expect(onRefused).toHaveBeenCalledWith(retryAfterSeconds);
  });

  it('says "player" for a team invitation', () => {
    expect(() => assertResendCooldown(new Date(), INVITATION_RESEND_COOLDOWN_MS, 'player')).toThrow(
      /just sent to this player/
    );
  });
});
