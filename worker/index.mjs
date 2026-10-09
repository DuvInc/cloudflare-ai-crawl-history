/**
 * The Worker: bindings in, `runCollector` out. All the logic is in `lib/`.
 *
 * It exports `scheduled` and nothing else. No `fetch`, no route, no
 * workers.dev hostname (see wrangler.jsonc): nothing on the internet can send
 * this Worker a request, which beats any amount of guarding on an endpoint
 * that sits in front of bindings that can write. Reading the archive goes
 * through your own wrangler session (`npm run pull`). If you need an HTTP read
 * API, put it in a separate Worker with read-only access; docs/read-api.md
 * describes one.
 */

import { runCollector } from '../lib/collect.mjs';
import { createSource } from '../lib/cloudflare.mjs';
import { gzip, toNdjson } from '../lib/archive.mjs';

function store(bucket) {
  return {
    async put(key, rows) {
      /* `Content-Type: application/gzip` and never `Content-Encoding: gzip`.
         With the latter, every download, wrangler's included, is decompressed
         on the way out and the `.gz` file on disk is no longer gzip
         ("incorrect header check"). */
      await bucket.put(key, await gzip(toNdjson(rows)), { httpMetadata: { contentType: 'application/gzip' } });
    },
  };
}

function ledger(db, windowHours) {
  return {
    async done() {
      /* Filtered on the span: when the window size changes, an old 1 hour
         marker keyed `T12` must not stop the new 4 hour window `T12` from
         ever being collected. That exact collision happened in a migration. */
      const { results } = await db.prepare(
        `SELECT zone, hour FROM collector_runs WHERE status = 'ok' AND span_hours = ? AND ran_at >= ?`,
      ).bind(windowHours, new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString()).all();
      return new Set(results.map((r) => `${r.zone} ${r.hour}`));
    },
    async mark({ zone, hour, span_hours, status, rows = 0, groups = 0, note = '' }) {
      await db.prepare(
        `INSERT INTO collector_runs (zone, hour, span_hours, ran_at, status, rows, groups, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (zone, hour) DO UPDATE SET span_hours = excluded.span_hours, ran_at = excluded.ran_at,
           status = excluded.status, rows = excluded.rows, groups = excluded.groups, note = excluded.note`,
      ).bind(zone, hour, span_hours, new Date().toISOString(), status, rows, groups, String(note).slice(0, 300)).run();
    },
  };
}

async function run(env) {
  const windowHours = Number(env.WINDOW_HOURS) || 4;
  const book = ledger(env.DB, windowHours);
  if (!env.CF_ANALYTICS_TOKEN) {
    /* Written to the ledger, not only thrown: an unset secret is the most
       likely reason this archives nothing, and the report is where you look. */
    await book.mark({ zone: '*', hour: new Date().toISOString().slice(0, 13), span_hours: 0, status: 'failed',
      note: 'CF_ANALYTICS_TOKEN is not set: npx wrangler secret put CF_ANALYTICS_TOKEN' });
    throw new Error('CF_ANALYTICS_TOKEN is not set');
  }
  const summary = await runCollector({
    source: createSource({ token: env.CF_ANALYTICS_TOKEN, accountId: env.CF_ACCOUNT_ID }),
    store: store(env.ARCHIVE),
    ledger: book,
    sites: env.SITES ?? [],
    windowHours,
    maxHorizonHours: Number(env.MAX_HORIZON_HOURS) || undefined,
    queryBudget: Number(env.QUERY_BUDGET) || undefined,
  });
  console.log(JSON.stringify({ collector: summary }));
  /* Thrown after everything is written, so a bad run shows as an error in the
     Cron Events dashboard instead of a green tick over an empty archive. */
  if (summary.failed > 0) throw new Error(`${summary.failed} window(s) failed: ${summary.errors.slice(0, 3).join(' | ')}`);
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
