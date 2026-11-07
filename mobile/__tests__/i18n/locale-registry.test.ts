/**
 * Locale registry guard (#671).
 *
 * `i18n/config.ts#LOCALES` is the one list of shipped languages: Metro bundles only
 * what is imported, so a `locales/<code>.json` that is not registered there never
 * reaches a device, and a registered code without a file cannot build. This keeps the
 * list and the directory equal, so adding a language is exactly "one file, one entry".
 */
import { readdirSync } from 'fs';
import { resolve } from 'path';

import i18n, { LOCALES, SUPPORTED_LANGUAGES } from '../../i18n/config';

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales');

describe('locale registry', () => {
  it('registers exactly the locale files that exist', () => {
    const files = readdirSync(LOCALES_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(files);
  });

  it('keeps English as the reference and the fallback', () => {
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(i18n.options.fallbackLng).toEqual(['en']);
  });

  it('loads every registered language into the running instance', () => {
    for (const code of SUPPORTED_LANGUAGES) {
      expect(i18n.hasResourceBundle(code, 'translation')).toBe(true);
      expect(i18n.getResourceBundle(code, 'translation')).toEqual(LOCALES[code]);
    }
  });

  it('accepts only the registered languages, so an unshipped device language resolves to English', async () => {
    expect(i18n.options.supportedLngs).toEqual(expect.arrayContaining(SUPPORTED_LANGUAGES));
    const device = i18n.cloneInstance({ lng: 'fr' });
    await device.changeLanguage('fr');
    expect(device.resolvedLanguage).toBe('en');
    expect(device.languages).toEqual(['en']);
    expect(device.t('common.cancel')).toBe(LOCALES.en.common.cancel);
  });

  it('resolves a shipped device language to itself', async () => {
    const device = i18n.cloneInstance({ lng: 'es' });
    await device.changeLanguage('es');
    expect(device.resolvedLanguage).toBe('es');
  });
});
