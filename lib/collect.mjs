/**
 * One collector run, with every side effect injected:
 *
 *   source   { zones, limits, readWindow }      see lib/cloudflare.mjs
 *   store    { put(key, rows) }                 R2 in the Worker, a Map in tests
 *   ledger   { done(), mark(entry) }            D1 in the Worker, an array in tests
 *
 * Nothing in this file reads the environment, opens a socket or logs.
 */

import { botName as defaultBotName, kindOf as defaultKindOf } from './classify.mjs';
import { keyFor, shape } from './archive.mjs';
import { bounds, dueWindows, horizonHours, hourKey, windowStart, DEFAULT_WINDOW_HOURS, DEFAULT_MAX_HORIZON_HOURS } from './windows.mjs';
import { DEFAULT_GROUP_LIMIT } from './cloudflare.mjs';

/** A window that still comes back full is split down to this, then given up on as `partial`. */
export const MIN_SPLIT_MS = 15 * 60 * 1000;

/**
 * GraphQL queries one run may spend. The account quota is 300 per 5 minutes,
 * shared with your dashboards, and a run that blows it fails every zone after
 * the one that hit it. What is not collected this run is collected by the
 * next, oldest first.
 */
export const DEFAULT_QUERY_BUDGET = 200;

class BudgetSpent extends Error {}

/**
 * Reads a window, halving it while the result is full. The two halves are
 * read one after the other, not in parallel: in parallel, a site with a bad
 * hour spends a burst of the shared quota in a second.
 */
export async function readAdaptive(read, { zoneId, since, until, botsOnly, limit, minSplitMs = MIN_SPLIT_MS }) {
  const { rows, truncated } = await read({ zoneId, since, until, botsOnly, limit });
  const span = new Date(until).getTime() - new Date(since).getTime();
  if (!truncated || span <= minSplitMs) return { rows, truncated, maxGroups: rows.length, queries: 1 };
  const mid = new Date(new Date(since).getTime() + span / 2);
  const a = await readAdaptive(read, { zoneId, since, until: mid, botsOnly, limit, minSplitMs });
  const b = await readAdaptive(read, { zoneId, since: mid, until, botsOnly, limit, minSplitMs });
  return {
    rows: [...a.rows, ...b.rows],
    truncated: a.truncated || b.truncated,
    maxGroups: Math.max(a.maxGroups, b.maxGroups),
    queries: 1 + a.queries + b.queries,
  };
}

async function collectWindow({ read, store, zone, zoneId, hour, windowHours, limit, kindOf, botName }) {
  const { since, until } = bounds(hour, windowHours);
  /* Two questions, never one. Bots only, per path: the half nobody can
     recover later. Everything, for the denominator: if it truncates, only the
     totals file is affected. */
  const bots = await readAdaptive(read, { zoneId, since, until, botsOnly: true, limit });
  const all = await readAdaptive(read, { zoneId, since, until, botsOnly: false, limit });
  const { crawl, totals } = shape({ hour, botRows: bots.rows, allRows: all.rows, kindOf, botName });

  /* Files first, marker last. A PUT replaces the whole object, so collecting a
     window again overwrites it exactly, and a run that dies between the two
     leaves no `ok` marker and the window is simply done again. */
  await store.put(keyFor(zone, 'crawl', hour), crawl);
  await store.put(keyFor(zone, 'totals', hour), totals);

  const status = bots.truncated || all.truncated ? 'partial' : 'ok';
  const note = bots.truncated
    ? `bot query still hit the ${limit} group cap at ${MIN_SPLIT_MS / 60000} minute slices: crawl rows are missing`
    : all.truncated ? `totals query hit the ${limit} group cap: only the totals are short` : '';
  return { status, note, rows: crawl.length, groups: Math.max(bots.maxGroups, all.maxGroups) };
}

/**
 * Collects every due window of every site, oldest first, until done or until
 * the query budget is spent. Returns a summary; throws nothing a single site
 * can cause. One site or one window failing is recorded as `failed` in the
 * ledger and the run moves on, because the next site's history is ageing out
 * at the same rate.
 */
export async function runCollector({
  source, store, ledger, sites, now = new Date(),
  windowHours = DEFAULT_WINDOW_HOURS, maxHorizonHours = DEFAULT_MAX_HORIZON_HOURS,
  queryBudget = DEFAULT_QUERY_BUDGET, kindOf = defaultKindOf, botName = defaultBotName,
}) {
  const summary = { ok: 0, partial: 0, failed: 0, skipped: 0, queries: 0, errors: [] };
  const runKey = hourKey(windowStart(now, windowHours));
  const markFailed = async (zone, hour, error) => {
    summary.failed += 1;
    summary.errors.push(`${zone} ${hour}: ${error.message}`);
    await ledger.mark({ zone, hour, span_hours: windowHours, status: 'failed', rows: 0, groups: 0, note: error.message });
  };

  let ids;
  try {
    ids = await source.zones();
  } catch (error) {
    /* Recorded run-level, not only thrown: a revoked token is the likeliest
       reason a collector produces nothing, and it has to show in the report. */
    await markFailed('*', runKey, error);
    return summary;
  }

  let spent = 0;
  const read = async (args) => {
    if (spent >= queryBudget) throw new BudgetSpent();
    spent += 1;
    return source.readWindow(args);
  };

  const done = await ledger.done();
  for (const site of sites) {
    const zoneId = ids.get(site.zone);
    if (!zoneId) {
      await markFailed(site.zone, runKey, new Error(`zone not visible to the token: add Zone > Zone > Read and Zone > Analytics > Read for ${site.zone}`));
      continue;
    }

    let limits = null;
    try {
      if (spent < queryBudget) { spent += 1; limits = await source.limits(zoneId); }
    } catch { /* Settings unreadable: fall back to the conservative horizon. */ }
    const horizon = horizonHours(limits?.notOlderThan, { maxHours: maxHorizonHours });
    const limit = Math.min(limits?.maxPageSize || DEFAULT_GROUP_LIMIT, DEFAULT_GROUP_LIMIT);

    for (const hour of dueWindows({ now, horizon, since: site.since, windowHours })) {
      if (done.has(`${site.zone} ${hour}`)) continue;
      if (spent >= queryBudget) { summary.skipped += 1; continue; }
      try {
        const result = await collectWindow({ read, store, zone: site.zone, zoneId, hour, windowHours, limit, kindOf, botName });
        await ledger.mark({ zone: site.zone, hour, span_hours: windowHours, ...result });
        summary[result.status] += 1;
      } catch (error) {
        if (error instanceof BudgetSpent) { summary.skipped += 1; continue; }
        await markFailed(site.zone, hour, error);
      }
    }
  }
  summary.queries = spent;
  return summary;
}
