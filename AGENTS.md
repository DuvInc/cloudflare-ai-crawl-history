# AGENTS.md

Instructions for any AI agent working in this repository. One file, no
per-vendor copy: Claude Code, Cursor, Codex and the rest all read `AGENTS.md`.

Most rules below exist because the failure they prevent is silent. A window
that was not collected looks like a quiet day. A truncated query looks like a
complete one. A wrong total looks like a total. Nobody notices until the data
can no longer be fetched again.

## What this repository is

A cron-only Cloudflare Worker that copies, every four hours, which verified
bot read which path of each listed site, from Cloudflare's GraphQL Analytics
API into gzipped NDJSON files in R2. A D1 table records each window. Local
scripts pull the files and report on them.

```text
GraphQL (bots only, all traffic) -> shape + fold -> R2 files -> D1 marker
                                                                   |
                         npm run pull -> .archive/ -> npm run report
```

The library in `lib/` is the product. The Worker is twenty lines of glue
around it. `bin/` are local tools. `demo/` is invented data so the report can
be seen without an account.

## Layout

| Path | What it is |
| :--- | :--- |
| `lib/collect.mjs` | `runCollector`: one run, every side effect injected. The adaptive split, the budget, failure isolation |
| `lib/cloudflare.mjs` | **the only file that talks to Cloudflare's API**: `zones`, `limits`, `readWindow` |
| `lib/archive.mjs` | file keys, NDJSON, gzip, and `shape()` from API groups to the two tables |
| `lib/classify.mjs` | `kindOf(path)` and `botName(userAgent)`. Applied before storage, same for every site |
| `lib/fold.mjs` | sums rows that collapse to the same key |
| `lib/windows.mjs` | window keys, due windows, the horizon from the API's retention |
| `lib/report.mjs` | health, `sum`, `isAi`, `urlParts`. Pure |
| `lib/jsonc.mjs` | reads `wrangler.jsonc` without a dependency |
| `worker/index.mjs` | the Worker: R2 and D1 bindings wrapped into `store` and `ledger` |
| `wrangler.jsonc` | the deployed config, including `SITES`. Placeholders until the user fills them |
| `schema.sql` | the D1 ledger, `collector_runs` |
| `bin/` | `preflight`, `pull`, `report`, `create-token.sh`, and the shared `config.mjs` |
| `demo/` | `make-sample.mjs` and the invented `sample-archive/` it writes |
| `docs/` | `reading-the-archive.md` (interpretation traps), `read-api.md` (giving others access) |
| `skills/ai-crawl-history/SKILL.md` | the procedure, as a skill |
| `test/` | 38 tests, no network, no token |

## Commands

```bash
npm test             # no network, no token, no cost
npm run demo         # report on the sample archive
npm run preflight    # read-only checks on the real config; add CF_ANALYTICS_TOKEN=... for the token
npm run deploy       # wrangler deploy
npm run pull         # ledger + files to .archive/
npm run report       # health, then numbers
```

`node demo/make-sample.mjs` regenerates the sample. It is deterministic; run
it after changing `shape()`, `kindOf` or `botName`, and commit the result so
the README excerpt still matches `npm run demo`.

## The rules

1. **The collector has no HTTP surface.** `worker/index.mjs` exports
   `scheduled` only, and `wrangler.jsonc` keeps `workers_dev: false` and
   `preview_urls: false`. A read API goes in a separate Worker without the
   analytics token; `docs/read-api.md` describes three. Do not add `fetch`
   here, not even a health route.
2. **`lib/` is pure outside `lib/cloudflare.mjs`.** No `process.env`, no
   `fetch`, no `console.log`. Transports, stores, ledgers, thresholds and
   clocks arrive as arguments. That is what makes the tests free and the
   library usable outside a Worker.
3. **Two queries per window, never one.** Bots only (`verifiedBotCategory_neq:
   ""`) and all traffic. Non-bot traffic is what fills the 10,000 group cap;
   sharing a query lets a scanner truncate the bot data.
4. **A full result is truncated until proven otherwise.** `rows.length >=
   limit` triggers the split. Never treat a result at the cap as complete,
   and never mark a window `ok` if any slice was still full at 15 minutes.
5. **Files first, marker last.** The `ok` row in D1 is written after both R2
   PUTs succeed. Reversing that order turns a crash into a window marked done
   with no file.
6. **The fold key is every stored field except the count, derived ones
   included.** Joined with `'\u0000'` written as an escape, never a literal
   NUL byte (a test checks the bytes).
7. **`botName` never returns `''`.** Unknown crawlers fall back to a token
   from their own User-Agent. The interesting bot is the one not on the list.
8. **The horizon is read, not assumed.** `limits()` reads `notOlderThan`
   from the API every run. Do not hardcode a retention from the docs; it has
   changed under this project once already.
9. **No IPs, no raw User-Agent, no per-path record of non-bot traffic.**
   They add privacy obligations and cardinality for no question this archive
   answers.
10. **No data rows in D1.** It bills each row once per index. The ledger is
    the only table, with its primary key and no other index.
11. **Health before numbers**, in every report, every JSON output, every
    answer an agent gives from this data.

## The contract of `lib/cloudflare.mjs`

`runCollector` needs a `source` with this shape, and nothing else:

```js
{
  async zones()                       // -> Map<zoneName, zoneId>
  async limits(zoneId)                // -> { notOlderThan, maxDuration, maxPageSize } | null
  async readWindow({ zoneId, since, until, botsOnly, limit })
                                      // -> { rows: [{ count, dimensions: {
                                      //        clientRequestHTTPHost, clientRequestPath, userAgent,
                                      //        verifiedBotCategory, clientCountryName, edgeResponseStatus } }],
                                      //      truncated: boolean }
}
```

`store.put(key, rows)` and `ledger.done()` / `ledger.mark(entry)` are the
other two seams; `worker/index.mjs` has the R2 and D1 versions, the tests have
in-memory ones. To use another storage, write those two objects. Do not
change `lib/collect.mjs` for it.

## Rules for agents

- **Never create, read, print or handle a Cloudflare token.** Not even when
  the user asks you to. Prepare the command (`bash bin/create-token.sh`, or
  the dashboard steps in the README) and hand it over. The script exists so
  that the value goes from Cloudflare into the Worker secret without passing
  through a terminal transcript.
- **Do not deploy, create buckets or run SQL against the user's account
  without asking.** `npm run preflight` and `npm run pull` are read-only;
  everything else changes something.
- **Do not commit a real archive.** `.archive/` is gitignored. The sample in
  `demo/` is generated and invented; keep it that way.
- **Do not add a dependency.** `wrangler` is the only one, because deploying
  a Worker needs it, and `npm test` does not. Anything else needs an issue.
- **Before quoting a number from the archive, read
  `docs/reading-the-archive.md`.** Then give health with it.
- **No em dashes** in code, comments, documentation or output.

## Things that bite

- **The 10,000 group cap is silent.** No error, no flag, just a result of
  exactly 10,000 rows. On one site a normal hour is 1,200 to 1,700 groups and
  a scanner hour went past the cap.
- **`Content-Encoding: gzip` on the R2 object breaks every download.**
  wrangler decompresses on the way out and the `.gz` on disk is plain text
  ("incorrect header check"). Use `Content-Type: application/gzip` only.
- **wrangler cannot list an R2 bucket.** The ledger is the index of files.
  The S3 API can list, which is why option 1 in `docs/read-api.md` needs no
  ledger.
- **Zone Analytics needs zones listed explicitly on the token.** A token
  scoped to "all zones from an account" can list the zone and still be refused
  its analytics. `preflight` tests the two separately for that reason.
- **`wrangler login` is one global session.** Another project can move it to
  another account, and the D1 database "does not exist". `preflight` checks
  `whoami` first.
- **Changing `WINDOW_HOURS` on a live archive.** An old 1 hour marker keyed
  `T12` and a new 4 hour window keyed `T12` share a primary key, and the old
  `ok` would stop the new window forever. `ledger.done()` filters on
  `span_hours` for that reason. Prefer a new database.
- **Deploying at the cron minute.** A deploy at :07 can land between two
  versions' runs. Deploy at any other minute.
- **D1 error 7403 is sometimes transient.** It once produced a false "83 of
  84 hours" in the health table. Retry once before investigating.
- **A new cron schedule takes a few minutes to start firing.** When testing
  with `*/5 * * * *`, nothing in the logs for the first minutes is normal.
- **The GraphQL quota is per user, 300 queries per 5 minutes**, shared with
  the dashboard. `QUERY_BUDGET` (200 by default) keeps a run under it. The
  split runs halves one after the other, not in parallel, for the same reason.
- **Workers Free is not enough.** 10 ms of CPU and 50 subrequests per cron
  run. Do not "optimise" for Free by dropping the totals query or the split;
  the data would be wrong instead of missing.
