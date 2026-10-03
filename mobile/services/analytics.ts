import * as amplitude from '@amplitude/analytics-react-native';
import Constants from 'expo-constants';
import { log } from './log';

/**
 * The Amplitude event catalogue (#616).
 *
 * Every event the app can send is named here and nowhere else: `trackEvent`
 * accepts only these values, and `AnalyticsEventProps` below fixes the
 * properties each one carries. The catalogue is documented, one row per
 * event, in `docs/architecture/analytics.md`, and
 * `__tests__/analytics/catalogue-guard.test.ts` fails when a name here is
 * missing from that table, when a documented event is never emitted, or when
 * a mutation hook fires nothing.
 *
 * Naming: `snake_case`, `<object>_<past-tense verb>`. Properties carry ids,
 * enums, counts and booleans only: never a name, an email, a jersey number or
 * free text (the no-PII rule in the doc).
 */
export const AnalyticsEvents = {
  APP_OPENED: 'app_opened',
  SCREEN_VIEWED: 'screen_viewed',
  USER_LOGGED_IN: 'user_logged_in',
  USER_LOGGED_OUT: 'user_logged_out',
  ONBOARDING_STEP_COMPLETED: 'onboarding_step_completed',
  PROFILE_UPDATED: 'profile_updated',
  ACCOUNT_DELETED: 'account_deleted',
  CHILD_RECORD_DELETED: 'child_record_deleted',
  TEAM_CREATED: 'team_created',
  TEAM_UPDATED: 'team_updated',
  TEAM_DELETED: 'team_deleted',
  ROSTER_PLAYER_ADDED: 'roster_player_added',
  ROSTER_PLAYER_UPDATED: 'roster_player_updated',
  ROSTER_PLAYER_REMOVED: 'roster_player_removed',
  PLAYER_UPDATED: 'player_updated',
  STAFF_ADDED: 'staff_added',
  STAFF_ROLE_UPDATED: 'staff_role_updated',
  STAFF_REMOVED: 'staff_removed',
  INVITATION_SENT: 'invitation_sent',
  INVITATION_ACCEPTED: 'invitation_accepted',
  INVITATION_DECLINED: 'invitation_declined',
  INVITATION_CANCELLED: 'invitation_cancelled',
  GUARDIAN_INVITED: 'guardian_invited',
  GUARDIAN_REMOVED: 'guardian_removed',
  ANNOUNCEMENT_CREATED: 'announcement_created',
  ANNOUNCEMENT_REPLY_CREATED: 'announcement_reply_created',
  ANNOUNCEMENT_REPLY_DELETED: 'announcement_reply_deleted',
  LEAGUE_CREATED: 'league_created',
  LEAGUE_UPDATED: 'league_updated',
  LEAGUE_DELETED: 'league_deleted',
  SEASON_CREATED: 'season_created',
  SEASON_UPDATED: 'season_updated',
  SEASON_DELETED: 'season_deleted',
  GAME_CREATED: 'game_created',
  GAME_UPDATED: 'game_updated',
  GAME_STARTED: 'game_started',
  GAME_FINISHED: 'game_finished',
  GAME_DELETED: 'game_deleted',
  GAME_EVENT_RECORDED: 'game_event_recorded',
  GAME_EVENT_UNDONE: 'game_event_undone',
  RSVP_SUBMITTED: 'rsvp_submitted',
  PUSH_PERMISSION_ANSWERED: 'push_permission_answered',
  NOTIFICATION_OPENED: 'notification_opened',
  ENTITLEMENT_DENIED: 'entitlement_denied',
  ERROR_SHOWN: 'error_shown',
} as const;

export type AnalyticsEvent = (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

/** A property value: ids, enums, counts, flags. Never free text from a user. */
export type AnalyticsValue = string | number | boolean;

/**
 * The properties each event carries, checked at compile time. An event with
 * no properties maps to `undefined`. Keep the glossary in
 * `docs/architecture/analytics.md` in step: a new property name is a new row.
 */
export interface AnalyticsEventProps {
  app_opened: undefined;
  screen_viewed: { screen: string; params_kind: string };
  user_logged_in: undefined;
  user_logged_out: { reason: 'user' | 'session_expired' | 'account_deleted' };
  onboarding_step_completed: { step: 'name' | 'role'; role?: string };
  profile_updated: {
    name_changed: boolean;
    photo_changed: boolean;
    photo_cleared: boolean;
    reply_notifications_changed: boolean;
  };
  account_deleted: { erased: boolean };
  child_record_deleted: undefined;
  team_created: { team_id: string; league_scope: 'personal' | 'league'; has_bracket: boolean };
  team_updated: { team_id: string; fields: string };
  team_deleted: { team_id: string };
  roster_player_added: {
    team_id: string;
    rostered: boolean;
    invited: boolean;
    guardian_invited: boolean;
    has_jersey: boolean;
    has_position: boolean;
    has_photo: boolean;
  };
  roster_player_updated: { team_id: string; fields: string };
  roster_player_removed: { team_id: string };
  player_updated: { fields: string };
  staff_added: { team_id: string; role_type: string; by: 'user_id' | 'email' };
  staff_role_updated: { team_id: string; role_type: string };
  staff_removed: { team_id: string };
  invitation_sent: { team_id: string; invitation_id: string; resend: boolean; email_sent: boolean | null };
  invitation_accepted: { kind: 'team' | 'guardian'; source: 'in_app' | 'link' };
  invitation_declined: { invitation_id: string };
  invitation_cancelled: { team_id: string; invitation_id: string };
  guardian_invited: { team_id: string; relationship: string };
  guardian_removed: { team_id: string };
  announcement_created: { team_id: string };
  announcement_reply_created: { team_id: string; announcement_id: string };
  announcement_reply_deleted: { team_id: string; announcement_id: string; own: boolean };
  league_created: { league_id: string };
  league_updated: { league_id: string };
  league_deleted: { league_id: string };
  season_created: { season_id: string; league_id: string; has_dates: boolean };
  season_updated: { season_id: string; fields: string };
  season_deleted: { season_id: string };
  game_created: { game_id: string; team_id: string };
  game_updated: { game_id: string; fields: string };
  game_started: { game_id: string };
  game_finished: { game_id: string };
  game_deleted: { game_id: string };
  game_event_recorded: { game_id: string; event_type: string; shot_made?: boolean; shot_points?: number };
  game_event_undone: { game_id: string; event_type?: string };
  rsvp_submitted: { game_id: string; status: string; on_behalf_of_child: boolean };
  push_permission_answered: { granted: boolean };
  notification_opened: { target: 'game' | 'announcement' | 'team' | 'none' };
  entitlement_denied: { endpoint_pattern: string; feature: string; current_tier: string; required_tier: string };
  error_shown: { code: string; status: number | null; endpoint_pattern: string };
}

/** Events whose props entry is `undefined` take no second argument. */
type PropsArgs<E extends AnalyticsEvent> = AnalyticsEventProps[E] extends undefined
  ? []
  : [properties: AnalyticsEventProps[E]];

/**
 * User properties set through `identify` (#616): who the user is to the
 * product, refreshed at login and whenever the source changes. Every value is
 * a flag, a count or an enum; the name and email never leave the device.
 */
export interface AnalyticsUserProperties {
  role: string;
  is_head_coach: boolean;
  is_assistant_coach: boolean;
  is_parent: boolean;
  is_player: boolean;
  team_count: number;
  tier: string;
  app_version: string;
}

/**
 * What the Amplitude SDK attaches to every event, stated explicitly (#559).
 *
 * `amplitude.init(apiKey)` with no options turns every one of these on, which
 * is how the app came to send more than the privacy-label draft assumed. The
 * values below are a decision, not a default: they are what the App Privacy
 * labels in `docs/release/app-store-submission.md` and the "Retention" section
 * of `docs/runbooks/data-subject-requests.md` declare. Change one here and
 * change it there; `__tests__/services/analytics.test.ts` pins the set.
 *
 * - `ipAddress: true` is deliberate. Amplitude resolves the request IP into
 *   city, region and country on its servers, and that coarse location is
 *   wanted for analytics. It is declared as Coarse Location on the label.
 * - `country: false` goes with it. That option is the country the DEVICE
 *   reports, and turning it on disables the server-side lookup, which would
 *   lose the city.
 * - `adid: false`. The Android advertising id serves ad attribution, the app
 *   shows no ads, and sending it would make the "no tracking" answer on the
 *   label false. iOS is unaffected: the SDK never reads the IDFA there.
 * - Everything else is device and OS context used to read the events.
 */
export const AMPLITUDE_TRACKING_OPTIONS: Required<amplitude.Types.ReactNativeTrackingOptions> = {
  adid: false,
  appSetId: true,
  carrier: true,
  country: false,
  deviceManufacturer: true,
  deviceModel: true,
  idfv: true,
  ipAddress: true,
  language: true,
  osName: true,
  osVersion: true,
  platform: true,
};

let initialized = false;
/** True until `initAnalytics` has decided (key missing, init failed, or ready). */
let initPending = true;

interface BufferedEvent {
  event: AnalyticsEvent;
  properties: Record<string, AnalyticsValue> | undefined;
}

/**
 * Events tracked before init has resolved. The root layout's children mount
 * (and the first `screen_viewed` fires) before its own `initAnalytics` effect
 * runs, and `amplitude.init` takes a moment, so the launch route would be lost
 * without this. Bounded; flushed in order once init succeeds; dropped when
 * there is no key or init fails.
 */
export const PRE_INIT_BUFFER_LIMIT = 50;
let preInitBuffer: BufferedEvent[] = [];

/**
 * Initialize Amplitude analytics.
 * No-ops gracefully if the API key is not configured.
 */
export async function initAnalytics(): Promise<void> {
  const apiKey = Constants.expoConfig?.extra?.amplitudeApiKey;
  if (!apiKey) {
    log.debug('[Analytics] No Amplitude API key configured, skipping initialization');
    initPending = false;
    preInitBuffer = [];
    return;
  }

  try {
    await amplitude.init(apiKey, undefined, {
      trackingOptions: AMPLITUDE_TRACKING_OPTIONS,
    }).promise;
    initialized = true;
    const buffered = preInitBuffer;
    preInitBuffer = [];
    for (const { event, properties } of buffered) send(event, properties);
  } catch (error) {
    log.warn('[Analytics] Failed to initialize Amplitude', { error });
    preInitBuffer = [];
  } finally {
    initPending = false;
  }
}

/**
 * Track a catalogued event. The properties are typed per event
 * (`AnalyticsEventProps`); an event without properties takes none. Never
 * throws: analytics cannot crash the app.
 */
export function trackEvent<E extends AnalyticsEvent>(event: E, ...args: PropsArgs<E>): void {
  const properties = args[0] as Record<string, AnalyticsValue> | undefined;
  if (initialized) {
    send(event, properties);
    return;
  }
  if (!initPending) return;
  if (preInitBuffer.length >= PRE_INIT_BUFFER_LIMIT) preInitBuffer.shift();
  preInitBuffer.push({ event, properties });
}

/**
 * The identity at the moment of the call. `amplitude.track` only enqueues;
 * the SDK stamps `user_id` / `device_id` on a later tick, and `reset()` is
 * synchronous. Without this, `user_logged_out` and `account_deleted`, which
 * are tracked immediately before `resetUser()`, would land on the fresh
 * anonymous identity. An explicit id in the event options wins over the
 * context plugin's.
 */
function identityNow(): { user_id?: string; device_id?: string } {
  const user_id = amplitude.getUserId();
  const device_id = amplitude.getDeviceId();
  return { ...(user_id ? { user_id } : {}), ...(device_id ? { device_id } : {}) };
}

function send(event: AnalyticsEvent, properties: Record<string, AnalyticsValue> | undefined): void {
  try {
    amplitude.track(event, properties, identityNow());
  } catch (error) {
    log.warn('[Analytics] Failed to track event', { event, error });
  }
}

/**
 * Identify the current user for analytics, optionally with user properties.
 */
export function identifyUser(userId: string, properties?: Partial<AnalyticsUserProperties>): void {
  if (!initialized) return;

  try {
    amplitude.setUserId(userId);
    if (properties) {
      applyUserProperties(properties);
    }
  } catch (error) {
    log.warn('[Analytics] Failed to identify user', { error });
  }
}

/**
 * Refresh some user properties without changing the user id. Callers pass
 * what they know (the auth store knows the role, the teams list knows the
 * staff roles and count, the usage query knows the tier); `undefined` values
 * are skipped so a partial refresh never clears a property.
 */
export function setUserProperties(properties: Partial<AnalyticsUserProperties>): void {
  if (!initialized) return;

  try {
    applyUserProperties(properties);
  } catch (error) {
    log.warn('[Analytics] Failed to set user properties', { error });
  }
}

function applyUserProperties(properties: Partial<AnalyticsUserProperties>): void {
  const identifyObj = new amplitude.Identify();
  let any = false;
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    identifyObj.set(key, value);
    any = true;
  }
  if (any) amplitude.identify(identifyObj);
}

/** The app version for the `app_version` user property (OTA JS reads the binary's version). */
export function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

/**
 * Reset user identity on logout.
 */
export function resetUser(): void {
  if (!initialized) return;

  try {
    amplitude.reset();
  } catch (error) {
    log.warn('[Analytics] Failed to reset user', { error });
  }
}

/**
 * Join the keys of a payload into the `fields` property (`"name,status"`),
 * so an update event says what changed without carrying the values.
 */
export function changedFields(data: object | undefined): string {
  if (!data) return '';
  return Object.keys(data)
    .filter((key) => (data as Record<string, unknown>)[key] !== undefined)
    .sort()
    .join(',');
}

/**
 * `screen_viewed` properties from Expo Router's segments (`useSegments()`):
 * the route pattern, never the path, so `/teams/[id]` is sent and the team id
 * is not. `params_kind` names the dynamic segments (`id`, `id,playerId`,
 * `token`) or is `none` for a static route.
 */
export function screenViewFromSegments(segments: readonly string[]): AnalyticsEventProps['screen_viewed'] {
  const screen = segments.length === 0 ? '/' : `/${segments.join('/')}`;
  const params = segments
    .filter((segment) => segment.startsWith('[') && segment.endsWith(']'))
    .map((segment) => segment.slice(1, -1).replace(/^\.\.\./, ''));
  return { screen, params_kind: params.length === 0 ? 'none' : params.join(',') };
}
