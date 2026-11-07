/**
 * Season order for the rollover picker (#461). Mirrors the backend's
 * `team-service.ts#isSeasonAfter`: when BOTH seasons have a start date, the
 * target must start strictly later; when either has none there is nothing to
 * order them by, so it is allowed (a season's creation time says nothing about
 * when it is played). The API refuses a dated older season with 400
 * `season_not_after_source`.
 */
export interface OrderedSeason {
  startDate?: string | null;
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

export function isSeasonAfter(target: OrderedSeason, source: OrderedSeason): boolean {
  const targetStart = time(target.startDate);
  const sourceStart = time(source.startDate);
  if (targetStart !== null && sourceStart !== null) {
    return targetStart > sourceStart;
  }
  return true;
}
