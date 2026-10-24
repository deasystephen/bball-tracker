/**
 * Internationalization configuration
 */

import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';

import en from './locales/en.json';
import es from './locales/es.json';

/**
 * Every language the app ships, keyed by its language code. `en` is the reference
 * and the fallback. To add a language: add `locales/<code>.json` with every key of
 * `en.json` translated, and one entry here. `__tests__/i18n/locale-registry.test.ts`
 * fails until both exist, and `locale-parity.test.ts` then holds the new file to the
 * same keys, placeholders and no-copied-English rule as Spanish.
 */
export const LOCALES = { en, es } as const;

export type SupportedLanguage = keyof typeof LOCALES;

export const SUPPORTED_LANGUAGES = Object.keys(LOCALES) as SupportedLanguage[];

const resources = Object.fromEntries(
  Object.entries(LOCALES).map(([code, translation]) => [code, { translation }]),
);

// Get device locale
const deviceLocale = getLocales()[0]?.languageCode || 'en';

const i18n = createInstance();

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: deviceLocale, // Use device locale, fallback to 'en'
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // React already escapes
    },
    compatibilityJSON: 'v4', // For React Native compatibility
  });

export default i18n;
