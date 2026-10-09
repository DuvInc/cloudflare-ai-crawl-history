-- The collector's ledger. The DATA is not here: it is gzipped NDJSON in the
-- R2 bucket (see lib/archive.mjs). Storing data rows in D1 was tried first,
-- and every row was billed once per index it touched: 83% of the account's
-- Cloudflare bill. This table gets about 6 rows per site per day.
--
-- One row per (site, window) attempted. It does three jobs:
--   1. the collector's idempotency guard: an `ok` window is never read again;
--   2. the list of files `npm run pull` downloads, because wrangler cannot
--      list an R2 bucket;
--   3. the health check printed before any number.
CREATE TABLE IF NOT EXISTS collector_runs (
  zone        TEXT    NOT NULL,             -- example.com, or '*' for a run-level failure
  hour        TEXT    NOT NULL,             -- window start, UTC: 2026-10-10T04
  span_hours  INTEGER NOT NULL,             -- window length; 4 unless you changed WINDOW_HOURS
  ran_at      TEXT    NOT NULL,             -- when it was last attempted
  status      TEXT    NOT NULL,             -- ok | partial | failed
  rows        INTEGER NOT NULL DEFAULT 0,   -- lines in the crawl file
  groups      INTEGER NOT NULL DEFAULT 0,   -- largest single API response; near 10,000 means a split was needed
  note        TEXT    NOT NULL DEFAULT '',  -- why, when not ok
  PRIMARY KEY (zone, hour)
);
-- No other index. Every index is one more billed write per row.
