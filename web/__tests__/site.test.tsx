import { readFileSync } from 'fs';
import path from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Home from '../app/page';
import { GET } from '../app/health/route';
import { SiteFooter } from '../app/site-footer';
import SupportPage from '../app/support/page';
import { AppStoreLink } from '../app/store-links';
import { APP_STORE_URL } from '../lib/open-in-app';
import { SUPPORT_EMAIL } from '../lib/site';

const ROOT = path.resolve(__dirname, '../..');

function quotedConstant(file: string, name: string): string | undefined {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  return source.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1];
}

describe('support page (#450)', () => {
  it('uses the same support address as the backend and the app', () => {
    expect(quotedConstant('backend/src/services/mailer/templates/brand.ts', 'SUPPORT_EMAIL')).toBe(SUPPORT_EMAIL);
    expect(quotedConstant('mobile/config/env.ts', 'SUPPORT_EMAIL')).toBe(SUPPORT_EMAIL);
  });

  it('links the support address', () => {
    const html = renderToStaticMarkup(<SupportPage />);
    expect(html).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
  });
});

describe('store links before the App Store release (#30)', () => {
  it('renders "coming soon", not the store page that says "not available"', () => {
    for (const html of [renderToStaticMarkup(<Home />), renderToStaticMarkup(<AppStoreLink compact />)]) {
      expect(html).toContain('coming soon to the App Store');
      expect(html).not.toContain(APP_STORE_URL);
    }
  });

  it('never links to Google Play: there is no Android listing', () => {
    expect(renderToStaticMarkup(<Home />)).not.toContain('play.google.com');
  });
});

describe('site footer', () => {
  it('links support, privacy and terms', () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    for (const href of ['/support', '/privacy', '/terms']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});

describe('/health', () => {
  it('answers ok with the commit the image was built from', async () => {
    vi.stubEnv('GIT_COMMIT', 'abc1234');
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', commit: 'abc1234' });
  });
});
