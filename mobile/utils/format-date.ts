/**
 * Locale-aware date and time formatting for every screen that shows a game
 * date, game time, event time or season date (#769).
 *
 * The locale is the device's full BCP 47 tag (`en-GB`, `es-ES`), read once
 * from the ExpoLocalization native module. A bare language code such as
 * i18next's `en` is not enough: it would give an `en-GB` device a 12-hour
 * clock. The module is reached through `requireOptionalNativeModule`, never
 * the expo-localization wrapper, so an OTA can never crash a binary that lacks
 * it; when it is missing or reports nothing, the locale is `undefined` and
 * Hermes falls back to the device default. Never pass a hard-coded locale
 * such as US English to a `toLocale*String` call (a source-scanning guard in
 * `__tests__/utils/date-locale-guard.test.ts` fails CI on it).
 */
import { requireOptionalNativeModule } from 'expo';

interface LocalizationNative {
  getLocales: () => readonly { languageTag?: string | null }[];
}

function isLocalizationNative(mod: unknown): mod is LocalizationNative {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    typeof (mod as { getLocales?: unknown }).getLocales === 'function'
  );
}

/** `null` until resolved; then the tag, or `undefined` for the device default. */
let cached: string | undefined | null = null;

/** The device's preferred locale tag, resolved once. Never throws. */
export function deviceLocale(): string | undefined {
  if (cached === null) {
    try {
      const mod: unknown = requireOptionalNativeModule('ExpoLocalization');
      const tag = isLocalizationNative(mod) ? mod.getLocales()[0]?.languageTag : undefined;
      cached = typeof tag === 'string' && tag.length > 0 ? tag : undefined;
    } catch {
      cached = undefined;
    }
  }
  return cached;
}

/** Test hook: forget the cached locale so the next call re-probes. */
export function resetDeviceLocaleCacheForTests(): void {
  cached = null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Short game date, e.g. "Fri, Oct 3" (GameCard). */
export function formatShortDate(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** Long game date, e.g. "Friday, October 3, 2026" (game detail, game stats, Create Game). */
export function formatLongDate(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Season date, e.g. "March 6, 2027", or `notSet` when there is no date. */
export function formatSeasonDate(date: Date | null, notSet: string): string {
  if (!date) return notSet;
  return date.toLocaleDateString(deviceLocale(), { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Clock time, e.g. "7:30 PM" or "19:30"; `seconds` adds the seconds (EventTimeline). */
export function formatClockTime(value: Date | string, options: { seconds?: boolean } = {}): string {
  return toDate(value).toLocaleTimeString(deviceLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
  });
}
