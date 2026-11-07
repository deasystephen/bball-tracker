/**
 * Season order for the rollover picker (#461). Mirrors the backend's
 * `team-service.ts#isSeasonAfter`: `target` comes after `source` by start date
 * when both have one, else by when each season was created; equal is not
 * after. The picker offers only such seasons; the API refuses any other with
 * 400 `season_not_after_source`.
 */
export interface OrderedSeason {
  startDate?: string | null;
  createdAt?: string;
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
  const targetCreated = time(target.createdAt);
  const sourceCreated = time(source.createdAt);
  // Without the facts to order them, leave the season out; the API decides.
  if (targetCreated === null || sourceCreated === null) return false;
  return targetCreated > sourceCreated;
}
