/**
 * Reading the archive. Pure: rows and ledger entries in, plain objects out.
 * `bin/report.mjs` does the files and the printing.
 *
 * Two rules every function here follows, because both were broken once:
 *
 *   - Health comes first. A window not collected before it aged out is gone,
 *     and a total over a range with holes looks exactly like a total.
 *   - Counts are `SUM(requests)`. A row is a group, not a request, and
 *     counting rows produced a number that disagreed with one reported five
 *     minutes earlier.
 */

import { HOUR_MS, DEFAULT_WINDOW_HOURS, windowStart } from './windows.mjs';

/**
 * Per site: how many hours of the range are covered by an `ok` window.
 *
 * The range starts at the later of "N days ago" and the site's first window
 * in the ledger. Without that bound, a four day old archive once reported 86
 * missing days, which is true and useless.
 */
export function health(ledger, { now = new Date(), days = 14, windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  /* Only windows the cron can already have collected are due: it runs a few
     minutes after each boundary. */
  const due = windowStart(new Date(new Date(now).getTime() - 10 * 60_000), windowHours).getTime();
  const rangeStart = new Date(now).getTime() - days * 24 * HOUR_MS;
  const zones = [...new Set(ledger.filter((r) => r.zone !== '*').map((r) => r.zone))].sort();
  const sites = zones.map((zone) => {
    const own = ledger.filter((r) => r.zone === zone);
    const covered = new Map();
    for (const r of own.filter((r) => r.status === 'ok' || r.status === 'partial')) {
      const t0 = new Date(`${r.hour}:00:00Z`).getTime();
      for (let i = 0; i < (r.span_hours || windowHours); i += 1) {
        if (covered.get(t0 + i * HOUR_MS) !== 'ok') covered.set(t0 + i * HOUR_MS, r.status);
      }
    }
    const firstSeen = Math.min(...own.map((r) => new Date(`${r.hour}:00:00Z`).getTime()));
    const first = Math.max(Math.floor(rangeStart / HOUR_MS) * HOUR_MS, firstSeen);
    /* Three states per hour: complete, partial (some rows are known to be
       missing), and missing (nothing at all). Only the last one is a hole. */
    let expected = 0; let missing = 0; let short = 0;
    for (let t = first; t < due; t += HOUR_MS) {
      expected += 1;
      if (!covered.has(t)) missing += 1;
      else if (covered.get(t) === 'partial') short += 1;
    }
    return {
      site: zone,
      since: new Date(first).toISOString().slice(0, 13),
      hours: `${expected - missing - short}/${expected}`,
      missing,
      partial_hours: short,
      partial: own.filter((r) => r.status === 'partial').length,
      failed: own.filter((r) => r.status === 'failed').length,
    };
  });
  const problems = ledger.filter((r) => r.status !== 'ok').sort((a, b) => (a.hour < b.hour ? 1 : -1));
  return { sites, problems, healthy: sites.every((s) => s.missing === 0) && !ledger.some((r) => r.zone === '*' && r.status === 'failed') };
}

/**
 * `SELECT by..., SUM(requests) ... GROUP BY by... ORDER BY 2 DESC`, plus a
 * distinct count when asked. Enough for every section of the report; for
 * anything else, point DuckDB at the files (README, "Ad hoc SQL").
 */
export function sum(rows, by, { where = () => true, value = 'requests', distinct, limit } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (!where(row)) continue;
    const key = by.map((f) => String(typeof f === 'function' ? f(row) : row[f]));
    const k = key.join('\u0000');
    let g = groups.get(k);
    if (!g) { g = { key, total: 0, seen: distinct ? new Set() : null }; groups.set(k, g); }
    g.total += Number(row[value]) || 0;
    if (distinct) g.seen.add(row[distinct]);
  }
  const names = by.map((f, i) => (typeof f === 'function' ? f.label ?? `col${i}` : f));
  const out = [...groups.values()]
    .sort((a, b) => b.total - a.total || a.key.join().localeCompare(b.key.join()))
    .map((g) => ({
      ...Object.fromEntries(names.map((n, i) => [n, g.key[i]])),
      [value]: g.total,
      ...(distinct ? { [`distinct_${distinct}`]: g.seen.size } : {}),
    }));
  return limit ? out.slice(0, limit) : out;
}

/**
 * Cloudflare's own category names say "AI" for the ones this archive exists
 * for: `AI Crawler`, `AI Search`, `AI Assistant`. Matched loosely because the
 * list has grown before.
 */
export const isAi = (row) => /\bAI\b/.test(row.bot_category ?? '');

/**
 * Site URL conventions, applied at read time. Pass your own locale list; an
 * unlisted prefix reads as a section, not a locale. Kinds without a locale
 * (assets, feeds, llms.txt) must be excluded before any locale split, or the
 * empty locale, which usually means the default language, is inflated.
 */
export function urlParts(path, { locales = [], prefix = '' } = {}) {
  let p = String(path ?? '');
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length) || '/';
  const first = p.split('/')[1] ?? '';
  const locale = locales.includes(first) ? first : '';
  const rest = locale ? p.slice(locale.length + 1) || '/' : p;
  /* `/index.md` is the home page's twin, not a section called "index". */
  const section = (rest.split('/')[1] ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/^index$/i, '');
  return { locale, section };
}
