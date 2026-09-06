/**
 * Shared response serializers.
 */

/**
 * Return a shallow copy of `row` without the named secret field.
 *
 * Bearer secrets (invitation `token`, and any later join/claim code) must never
 * appear on an authenticated response. The service layer keeps them out with
 * explicit `select` constants (audit #14); this is the route-layer second
 * line, kept generic so each secret is stripped by the same code path and a
 * fix to one is a fix to all. A row that does not carry the key is returned
 * as-is (no copy), which keeps `.map(omitToken)` cheap on lists.
 */
export function omitSecret<T extends object, K extends string>(row: T, key: K): Omit<T, K> {
  if (!(key in row)) {
    return row;
  }
  const copy = { ...row } as Record<string, unknown>;
  delete copy[key];
  return copy as Omit<T, K>;
}
