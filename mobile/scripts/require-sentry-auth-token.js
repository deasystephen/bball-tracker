#!/usr/bin/env node
/**
 * First step of `npm run ota:production` (#644): refuse to publish an OTA that
 * Sentry could not symbolicate. `postota:production` uploads the bundle and
 * source maps `eas update` leaves in dist/, and needs SENTRY_AUTH_TOKEN in the
 * publishing shell (the EAS copy is builder-only). Checking it here, before
 * `eas update`, means a missing token stops the publish instead of failing
 * after the bundle is already live.
 */

'use strict';

const raw = process.env.SENTRY_AUTH_TOKEN;

if (!raw || !raw.trim()) {
  console.error(
    '[ota] SENTRY_AUTH_TOKEN is not set. The OTA would ship a bundle Sentry cannot symbolicate.\n' +
      '      Pass a satsun-ventures org token for this command only, from the macOS Keychain:\n' +
      '      SENTRY_AUTH_TOKEN="$(security find-generic-password -a "$USER" -s sentry-auth-token -w)" npm run ota:production -- --message "…"\n' +
      '      See docs/deployment/mobile-builds-and-ota.md, "Publishing a production OTA: the Sentry token".'
  );
  process.exit(1);
}

if (raw !== raw.trim()) {
  // sentry-cli sends it verbatim and the API answers "Invalid token header".
  console.error('[ota] SENTRY_AUTH_TOKEN has leading or trailing whitespace; export it again without it.');
  process.exit(1);
}
