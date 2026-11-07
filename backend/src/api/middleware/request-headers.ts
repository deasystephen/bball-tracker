/**
 * The two client-supplied correlation headers (#963). Both are untrusted
 * input: they are validated here and a value that fails is dropped, never
 * logged and never an error. Neither is ever used for authorization.
 *
 * - `X-Request-Id`: a canonical UUID (8-4-4-4-12 hex, any version, either
 *   case). A valid value becomes the request's `requestId`, so a client can
 *   tag its own error report with the id the API's log lines carry; anything
 *   else is replaced by a server-generated UUID. The id used is echoed on
 *   every response as `X-Request-Id`.
 * - `X-Hooplings-Client`: `web`, or `ios/<version>` / `android/<version>`
 *   with an optional `+<build>` suffix (`ios/1.6.0+<updateId>`), at most 64
 *   characters. A valid value is logged as `client`.
 *
 * The contract is written down in docs/architecture/backend-services.md
 * (Logging, "Correlation headers"); the mobile and web clients follow it.
 */

import { z } from 'zod';

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const CLIENT_HEADER = 'X-Hooplings-Client';

export const CLIENT_HEADER_MAX_LENGTH = 64;

/** Canonical UUID text form; the version and variant nibbles are not checked. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `web`, or a platform, a 1-4 part numeric version and an optional build suffix. */
const CLIENT_PATTERN = /^(?:web|(?:ios|android)\/\d{1,4}(?:\.\d{1,4}){0,3}(?:\+[A-Za-z0-9._-]{1,40})?)$/;

export const requestIdHeaderSchema = z.string().regex(UUID_PATTERN);

export const clientHeaderSchema = z.string().max(CLIENT_HEADER_MAX_LENGTH).regex(CLIENT_PATTERN);

/** The client's request id when it is a UUID, else `undefined`. */
export function parseRequestIdHeader(raw: unknown): string | undefined {
  const result = requestIdHeaderSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** The client identifier when it matches the contract, else `undefined`. */
export function parseClientHeader(raw: unknown): string | undefined {
  const result = clientHeaderSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
