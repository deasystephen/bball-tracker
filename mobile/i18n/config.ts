/**
 * Internationalization configuration
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';

// Import translation files (we'll create these)
import en from './locales/en.json';
import es from './locales/es.json';

const resources = {
  en: { translation: en },
  es: { translation: es },
};

// Get device locale
const deviceLocale = getLocales()[0]?.languageCode || 'en';

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: deviceLocale, // Use device locale, fallback to 'en'
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // React already escapes
    },
    compatibilityJSON: 'v3', // For React Native compatibility
  });

export default i18n;
