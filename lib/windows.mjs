/**
 * Time. Every window is a fixed slice aligned to UTC midnight, keyed by the
 * hour it starts: with 4 hour windows, `2026-10-10T00`, `T04`, ... `T20`.
 *
 * Why 4 hours and not a day: the GraphQL API returns at most 10,000 groups per
 * query and does not say when it truncated. A day of a 37,000 page site is
 * well over that. Why not 1 hour: six times the files and queries for the same
 * data, and an hour is finer than any question this archive can answer.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_WINDOW_HOURS = 4;

/**
 * How far back to look for windows that are not collected yet, when the API
 * cannot tell us. 20 hours: the per-path detail was readable for 24 on every
 * plan until September 2026 (30 days since), so this is safe anywhere, and 4
 * hours of margin cover a late run and the API's own lag.
 */
export const FALLBACK_HORIZON_HOURS = 20;

/** Never backfill more than this, whatever the API allows: see `horizonHours`. */
export const DEFAULT_MAX_HORIZON_HOURS = 7 * 24;

export const hourKey = (date) => new Date(date).toISOString().slice(0, 13);

export function windowStart(date, windowHours = DEFAULT_WINDOW_HOURS) {
  const span = windowHours * HOUR_MS;
  return new Date(Math.floor(new Date(date).getTime() / span) * span);
}

export function bounds(hour, windowHours = DEFAULT_WINDOW_HOURS) {
  const since = new Date(`${hour}:00:00Z`);
  if (Number.isNaN(since.getTime())) throw new Error(`not a window key: ${hour}`);
  return { since, until: new Date(since.getTime() + windowHours * HOUR_MS) };
}

/**
 * How many hours back the collector may look, from what the API says it keeps.
 *
 * `notOlderThan` is the zone's own retention for the dataset, in seconds, read
 * from the GraphQL `settings` node. It depends on the plan and it has changed
 * over time, so it is read, never assumed. 4 hours of margin are taken off,
 * because a window at the very edge can age out between planning and reading.
 *
 * The cap exists for the first run. With a 31 day retention and no cap, the
 * first run would try ~186 windows per site, which is far above the GraphQL
 * quota of 300 queries per 5 minutes. A week is collected over a few runs, and
 * past that a site you just added does not need its history badly enough to
 * spend the quota on it.
 */
export function horizonHours(notOlderThanSeconds, { maxHours = DEFAULT_MAX_HORIZON_HOURS } = {}) {
  const fromApi = Number(notOlderThanSeconds);
  if (!Number.isFinite(fromApi) || fromApi <= 0) return Math.min(FALLBACK_HORIZON_HOURS, maxHours);
  return Math.max(0, Math.min(Math.floor(fromApi / 3600) - 4, maxHours));
}

/**
 * Every closed window within the horizon, oldest first, never before `since`.
 * Oldest first because those are the ones about to be lost for good.
 *
 * A window is closed once its end is in the past. The cron runs a few minutes
 * after each boundary (`:07`), which gives the source time to settle.
 */
export function dueWindows({ now, horizon, since, windowHours = DEFAULT_WINDOW_HOURS }) {
  const out = [];
  const floor = new Date(now).getTime() - horizon * HOUR_MS;
  const step = windowHours * HOUR_MS;
  for (let t = windowStart(now, windowHours).getTime() - step; t >= floor; t -= step) {
    const key = hourKey(t);
    if (!since || key >= since) out.unshift(key);
  }
  return out;
}
