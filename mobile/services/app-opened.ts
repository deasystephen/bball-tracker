import { trackEvent, setUserProperties, AnalyticsEvents } from './analytics';
import { getRunningBuild, type RunningBuild } from './app-build';

/**
 * The launch's analytics (#967), called by the root layout once
 * `initAnalytics` has settled: `app_opened` with which JavaScript is running,
 * and the build user properties. A rehydrated session never runs `setUser`,
 * so without the refresh here `update_id` would stay on the OTA of the last
 * sign-in.
 */
export function trackAppOpened(build: RunningBuild = getRunningBuild()): void {
  trackEvent(AnalyticsEvents.APP_OPENED, {
    launch: build.launch,
    update_id: build.updateId,
    runtime_version: build.runtimeVersion,
  });
  setUserProperties({ app_version: build.appVersion, update_id: build.updateId ?? 'embedded' });
}
