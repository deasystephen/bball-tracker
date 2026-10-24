import type { Instrumentation } from 'next';
import { log } from './lib/log';

/**
 * Next.js calls this for every error thrown while the server renders a page or
 * runs a route handler (#966). It is the site's server-side error report: one
 * `Web request error` line through `lib/log.ts`, forwarded to Datadog.
 *
 * Invitation URLs carry bearer tokens, so the line names the ROUTE PATTERN
 * (`context.routePath`, e.g. `/invite/[token]`) and never `request.path`, the
 * headers or the error's message (which can quote a URL). `digest` is the id
 * Next.js shows on its error page and prints beside its own (CloudWatch-only)
 * error output, so the two can be matched.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest = typeof error === 'object' && error !== null ? (error as { digest?: unknown }).digest : undefined;
  log.error('Web request error', {
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
    renderSource: context.renderSource ?? null,
    digest: typeof digest === 'string' ? digest : null,
    errorName: error instanceof Error ? error.name : typeof error,
  });
};
