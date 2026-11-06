/**
 * Suggested name for the season after `current` (#461, "Start next season").
 *
 * A personal league's season is named for its year ("2026", #442), and club
 * seasons usually carry one ("Fall 2026", "2026-27"). The suggestion moves
 * every year in the name forward by one; a two-digit second year in a span
 * ("2026-27") moves too. A name with no year gives no suggestion, so the
 * field starts empty rather than guessing.
 *
 * Only a prefill: the coach can edit it, and the backend finds an existing
 * season by this name or creates one.
 */
export function suggestNextSeasonName(current: string | null | undefined): string {
  if (!current) return '';

  const span = /\b(\d{4})([-/–])(\d{2}|\d{4})\b/;
  const spanMatch = current.match(span);
  if (spanMatch) {
    const [whole, first, separator, second] = spanMatch;
    const nextSecond =
      second.length === 2 ? String((Number(second) + 1) % 100).padStart(2, '0') : String(Number(second) + 1);
    return current.replace(whole, `${Number(first) + 1}${separator}${nextSecond}`);
  }

  const year = /\b(\d{4})\b/;
  const yearMatch = current.match(year);
  if (yearMatch) {
    return current.replace(year, String(Number(yearMatch[1]) + 1));
  }

  return '';
}
