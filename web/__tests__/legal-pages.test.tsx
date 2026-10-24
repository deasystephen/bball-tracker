import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PRIVACY_EMAIL, SUPPORT_EMAIL } from '../app/_legal/legal-document';
import PrivacyPolicyPage, { metadata as privacyMetadata } from '../app/privacy/page';
import TermsOfServicePage, { metadata as termsMetadata } from '../app/terms/page';

const REPO_ROOT = resolve(__dirname, '../..');

function render(page: () => ReactElement): string {
  return renderToStaticMarkup(page());
}

/** Rendered markup with tags stripped and whitespace collapsed, so phrases can be matched across elements. */
function text(page: () => ReactElement): string {
  return render(page)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/** The "Retention" section of the data-subject runbook, which CLAUDE.md says the policy must match. */
function runbookRetention(): string {
  const runbook = readFileSync(resolve(REPO_ROOT, 'docs/runbooks/data-subject-requests.md'), 'utf8');
  const start = runbook.indexOf('## Retention');
  const end = runbook.indexOf('\n## ', start + 1);
  expect(start).toBeGreaterThan(-1);
  return runbook.slice(start, end === -1 ? undefined : end);
}

const RETIRED_BRANDS = [/capy[\s_-]*hoops/i, /basketball[\s_-]*tracker/i];

describe('legal pages (#25)', () => {
  it('sets page titles', () => {
    expect(privacyMetadata.title).toBe('Privacy Policy | Hooplings');
    expect(termsMetadata.title).toBe('Terms of Service | Hooplings');
  });

  it('uses the backend support address', () => {
    const brand = readFileSync(resolve(REPO_ROOT, 'backend/src/services/mailer/templates/brand.ts'), 'utf8');
    expect(brand).toContain(`SUPPORT_EMAIL = '${SUPPORT_EMAIL}'`);
  });

  it.each([
    ['privacy', PrivacyPolicyPage],
    ['terms', TermsOfServicePage],
  ] as const)('%s page shows the effective-date placeholder and no retired brand', (_name, page) => {
    const html = render(page);
    expect(html).toContain('[EFFECTIVE DATE]');
    for (const pattern of RETIRED_BRANDS) expect(html).not.toMatch(pattern);
  });

  it('privacy page names the contacts and every service provider', () => {
    const body = text(PrivacyPolicyPage);
    expect(body).toContain(PRIVACY_EMAIL);
    expect(body).toContain(SUPPORT_EMAIL);
    for (const provider of ['Amazon Web Services', 'WorkOS', 'Amplitude', 'Sentry', 'Datadog', 'Expo', 'Google Workspace']) {
      expect(body).toContain(provider);
    }
  });

  it('privacy page states the retention windows the runbook states', () => {
    const body = text(PrivacyPolicyPage);
    const retention = runbookRetention();
    // Each pair: what the page says, and the runbook wording it restates. If the
    // runbook changes a window, this fails until the page is updated with it.
    const windows: Array<[string, string]> = [
      ['up to 7 days', 'up to **7 days**'],
      ['90 days by default', '90 days by default'],
      ['30 days in Amazon CloudWatch', 'kept **30 days** in CloudWatch Logs'],
      ['15 days in Datadog', 'kept for **15 days**'],
      ['“Deleted user”', 'attributed to "Deleted user"'],
      ['city, region and country', '**city,\n  region and country**'],
    ];
    for (const [page, runbook] of windows) {
      expect(body).toContain(page);
      expect(retention.replace(/\s+/g, ' ')).toContain(runbook.replace(/\s+/g, ' '));
    }
  });

  it('terms page links to the privacy policy', () => {
    expect(render(TermsOfServicePage)).toContain('href="/privacy"');
  });
});
