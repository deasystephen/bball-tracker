/**
 * Suggested name for the season after `current` (#461, "Start next season").
 *
 * A personal league's season is named for its year ("2026", #442), and club
 * seasons usually carry one ("Fall 2026", "2026-27", "Fall 2026 - Spring
 * 2027"). The suggestion moves EVERY year in the name forward by one; the
 * two-digit second year of a span ("2026-27", "2026 – 27") moves too. A name
 * with no year gives no suggestion, so the field starts empty rather than
 * guessing.
 *
 * Only a prefill: the coach can edit it, and the backend finds an existing
 * season by this name or creates one.
 */
export function suggestNextSeasonName(current: string | null | undefined): string {
  if (!current) return '';

  // A four-digit year, optionally followed by a span separator (hyphen, slash
  // or en dash, spaces allowed) and a two- or four-digit second year. Every
  // match moves forward, so "Fall 2026 - Spring 2027" becomes
  // "Fall 2027 - Spring 2028" and "2026 – 27" becomes "2027 – 28".
  const years = /\b(\d{4})(?:(\s*[-/\u2013]\s*)(\d{4}|\d{2}))?\b/g;
  let found = false;
  const next = current.replace(years, (_whole, first: string, separator?: string, second?: string) => {
    found = true;
    const bumped = String(Number(first) + 1);
    if (separator === undefined || second === undefined) return bumped;
    const bumpedSecond =
      second.length === 2 ? String((Number(second) + 1) % 100).padStart(2, '0') : String(Number(second) + 1);
    return `${bumped}${separator}${bumpedSecond}`;
  });

  return found ? next : '';
}
