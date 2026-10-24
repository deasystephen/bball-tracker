/**
 * `endpointPattern` of an axios request config: the base URL joined to a
 * relative `url` (an absolute `url` stands alone). The api-client's breadcrumbs,
 * tags and analytics and any caller that logs a failed request
 * (`hooks/useNotifications.ts`, #963) use this one join, so the same request
 * always groups under the same pattern.
 *
 * Its own module, not part of `services/sentry.ts`: screen tests mock the
 * Sentry module wholesale while running the real api-client.
 */

import { endpointPattern } from './sentry';

export function requestPattern(config?: { baseURL?: string; url?: string } | null): string {
  if (!config?.url) return '';
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(config.url);
  return endpointPattern(absolute || !config.baseURL ? config.url : `${config.baseURL}${config.url}`);
}
