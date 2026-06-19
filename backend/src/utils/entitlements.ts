/**
 * Backward-compatible re-export.
 *
 * The canonical, documented source of truth for the feature->tier map, usage
 * limits, and the FREE-tier team limit now lives in
 * `src/services/entitlements`. This file remains only so existing imports of
 * `../../utils/entitlements` keep working. New code should import from
 * `../../services/entitlements` directly.
 */

export * from '../services/entitlements';
