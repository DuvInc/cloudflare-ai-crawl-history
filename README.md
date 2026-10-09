# cloudflare-ai-crawl-history

**Cloudflare tells you which AI crawlers read which of your pages. Then it
forgets. This keeps it.**

If your site is on Cloudflare, every request from GPTBot, ClaudeBot,
PerplexityBot and the rest already goes through Cloudflare, which checks the
crawler's IP and labels it. That is the data behind AI Crawl Control, and
it's the only first-party view most sites have of how AI engines use them:
the GEO, or AEO, question.

The catch is the window. On the Free plan, AI Crawl Control showed the last
24 hours when this project started. It shows 30 days now. Either way the
detail ages out, and you can't compare this quarter with the last one, see
what changed after you shipped `llms.txt`, or check whether the crawlers ever
came back for the pages you rewrote.

This is a Cloudflare Worker that runs every four hours and copies that data,
per site, per page, per bot, into files in your own R2 bucket. One Worker covers
all your sites. The sites themselves run no code for it.

```bash
npm run pull && npm run report
```

```text
== Who takes the Markdown twins ==

    bot_name            pages_and_twins  twins  twin_share
    ------------------  ---------------  -----  ----------
    meta-externalagent             2571      0  0.0%
    GPTBot                         1678    729  43.4%
    ClaudeBot                      1241    663  53.4%
    Amazonbot                       687    178  25.9%
```

That's the invented sample archive in `demo/`. On a real job board with
14,984 Markdown twins, the first four days gave: **ClaudeBot took the `.md`
version 49.8% of the time, GPTBot 41.5%, Amazonbot 26.8%, and
meta-externalagent made 38,445 requests without ever taking one. `llms.txt`
got zero requests in the first three and a half days.** None of that is
visible in the dashboard a week later.

## What it costs

| | First version: rows in D1 | This version: files in R2 |
| :--- | ---: | ---: |
| Writes per site per day | ~150,000 billed rows | 12 objects |
| Storage per site per day | ~10 MB | ~1 MB |
| Share of the Cloudflare bill | 83% ($4.23 of $5.10, 30 days) | ~0 |
| Reading a year of data | billed per row read | free, on your machine |

Measured on the same site, a job board with about 37,000 distinct paths. You
need Workers Paid ($5 a month, see [What this is not](#what-this-is-not)).
R2, D1 and the GraphQL calls stay inside its included usage.

## How it works

```text
  every 4 hours, at :07 UTC
            |
            v
  Cloudflare GraphQL API, httpRequestsAdaptiveGroups, per site:
     1. verified bots only, per path      -> crawl   (the irreplaceable half)
     2. all traffic, per host and kind    -> totals  (the denominator)
            |
            |  window full at 10,000 groups? split in half, retry,
            |  down to 15 minutes
            v
  R2   <site>/crawl/<day>/<HH>.ndjson.gz
       <site>/totals/<day>/<HH>.ndjson.gz      files first
  D1   collector_runs: one row per window       marker last
            |
            v
  npm run pull     the ledger says which files exist, wrangler fetches them
  npm run report   health first, then the numbers, all local
```

**Four hour windows, because the API truncates silently.** A GraphQL query
returns at most 10,000 groups and doesn't tell you it stopped. On the job
board, a normal hour is 1,248 to 1,735 groups. A day is far over the cap. One
hour, scanners spraying `.env` and `wp-login.php` at thousands of paths sent
non-bot traffic up five to seven times and filled the query. That's why the
bot query and the all-traffic query are separate: the bot one carries
`verifiedBotCategory_neq: ""`, stays at 500 to 800 groups an hour, and a
scanner can't push it over. And it's why a full window is split and read
again, rather than trusted.

**Files, not rows.** The first version wrote rows to D1. D1 bills every row
once per index it touches, and that table had five indexes, so ~25,000 real
rows a day became ~150,000 billed writes, and the cheapest part of the setup
became 83% of the bill. One exploratory self-join then read 692 million rows
in an afternoon. The data is append-only and rarely read, so it's now two
gzipped files per window, and D1 keeps only the ledger, about six rows per
site per day.

**Self-healing.** Each run collects every window that closed within the
horizon and has no `ok` marker, oldest first. A run that fails, or a token
that expired on a Sunday, is repaired by the next run, as long as the data
is still within your plan's retention. Files are written before the marker
and a PUT replaces the whole object, so collecting a window twice gives the
same file.

**The horizon comes from the API.** Retention depends on your plan and it has
changed: AI Crawl Control went from 24 hours to 30 days on Free while its
docs still said 24. So each run reads the zone's own limit from the GraphQL
`settings` node, keeps a 4 hour margin, and caps itself at a week so the
first run doesn't burn the account's query quota (300 per 5 minutes) on
history. If the settings can't be read, it falls back to 20 hours, which is
safe on any plan. `npm run preflight` prints what your zones allow.

**No HTTP surface.** The Worker exports `scheduled` and nothing else: no
`fetch`, no route, no workers.dev hostname. It holds a token that reads your
analytics and bindings that write your archive, so the safest endpoint is no
endpoint. You read the archive through your own wrangler session. To give
someone else access, see [docs/read-api.md](docs/read-api.md).

## Try it without an account

```bash
git clone https://github.com/DuvInc/cloudflare-ai-crawl-history
cd cloudflare-ai-crawl-history
npm test            # 38 tests, no network, no token
npm run demo        # the report, on seven invented days of two invented sites
npm run demo:site   # one site, with sections and locales
```

The sample archive has one missing window and one partial one on purpose.
Read the first table: that's the habit the report is built to teach.

## Set it up on your sites

About fifteen minutes. You need a Cloudflare account with Workers Paid, Node
22, and the zones already on Cloudflare (proxied, orange cloud: requests that
don't go through Cloudflare aren't counted).

```bash
npm install                          # wrangler, the only dependency
npx wrangler login
npm run setup                        # creates the R2 bucket and the D1 database
```

Then edit `wrangler.jsonc`:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "ai-crawl-history", "database_id": "<from npm run setup>" }],
"vars": {
  "CF_ACCOUNT_ID": "<your account id>",
  "SITES": [
    { "zone": "example.com" },
    { "zone": "docs.example.org" }
  ]
}
```

```bash
npm run schema                       # creates the ledger table
bash bin/create-token.sh             # creates the read-only token, tests it, sets the secret
npm run deploy
```

`create-token.sh` uses Cloudflare's [`cf` CLI](https://github.com/cloudflare/cf) (`npm i -g cf`) and
never prints the token. To do it by hand instead: dashboard, My Profile, API
Tokens, Create Custom Token, with **Zone > Zone > Read** and
**Zone > Analytics > Read**, and under Zone Resources **each zone listed
explicitly**. Then:

```bash
CF_ANALYTICS_TOKEN=... npm run preflight
npx wrangler secret put CF_ANALYTICS_TOKEN
```

The first run comes within four hours. To check sooner, temporarily set the
cron to `*/5 * * * *`, deploy, wait for a run in the Worker's logs, and set it
back. A new cron schedule can take a few minutes to start firing. That test
caught a real bug before anyone trusted the archive.

Then, whenever you want to look:

```bash
npm run pull                         # last 30 days, only what changed
npm run report                       # every site
npm run report -- --site example.com --locales fr,de,es
npm run report -- --days 90 --json
```

### Adding a site later

Add a line to `SITES`, re-run `bash bin/create-token.sh` (the new token covers
every listed zone; delete the old one), and `npm run deploy`. The next run
collects as far back as the plan allows, capped at a week.

## Ad hoc SQL

The report covers the usual questions. For anything else, point
[DuckDB](https://duckdb.org) at the files. It reads gzipped NDJSON natively:

```sql
SELECT regexp_extract(filename, '([^/]+)/crawl/', 1) AS site,
       bot_name, kind, SUM(requests) AS requests
FROM read_json('.archive/*/crawl/*/*.ndjson.gz', filename = true)
WHERE bot_category LIKE 'AI%' AND day >= '2026-10-01'
GROUP BY ALL ORDER BY requests DESC;
```

| Table | Columns |
| :--- | :--- |
| `crawl` | `hour, day, host, path, kind, bot_category, bot_name, country, status, requests` |
| `totals` | `hour, day, host, kind, audience, requests` |

`kind` is `page`, `twin` (a `.md` file), `llms`, `feed` or `asset`.
`audience` is `bot` or `other`. Always `SUM(requests)`: a row is a group, not
a request. [docs/reading-the-archive.md](docs/reading-the-archive.md) covers
the mistakes that are easy to make here, all of them made at least once while
building this.

## Getting the data to other people

Three options, written up in [docs/read-api.md](docs/read-api.md) from a
deployment that serves several sites to a team:

1. **No Worker at all.** A read-only R2 token scoped to the bucket, and DuckDB
   reading `r2://` directly. Ten lines, nothing to host.
2. **A small read Worker with fixed endpoints** (`/health`, `/bots`,
   `/pages`), for a dashboard. Bearer token compared in constant time, every
   failure a bare 404, cached per question.
3. **SQL over HTTP**, DuckDB in a Cloudflare Container behind an identifier
   allowlist, for agents and exploratory teams. About 6 seconds cold, about
   $0 a month in normal use.

None of them is in this repository's code, deliberately. The collector stays
cron-only, and whatever reads goes in a separate Worker with no access to the
analytics token.

## What this is not

- **Not on Workers Free.** A Free cron run gets 10 ms of CPU and 50
  subrequests. Parsing one busy window is more than that. Workers Paid ($5 a
  month) gives 30 seconds and 10,000.
- **Not a referer log.** Below Enterprise, Cloudflare refuses the referer
  fields, so this can't tell you how a bot found a page, or in what order it
  read things. Rows are counts per window.
- **Not human analytics.** `other` includes every unverified crawler and
  scanner. It's an upper bound on humans, not a count of them.
- **Not a backfill tool.** It starts from what your plan still holds on day
  one. History older than that is gone.
- **Not the unverified long tail.** Only bots Cloudflare verified make it into
  `crawl`, because those are the only names you can trust. A crawler that lies
  about its User-Agent is in `totals` as `other`.

## Credits

Built on Cloudflare's [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/),
Workers, R2 and D1. The read options lean on [DuckDB](https://duckdb.org).
Extracted from a collector that ran on a job board first, then on several
sites at once.

MIT licensed. See [CONTRIBUTING.md](./CONTRIBUTING.md) to send a patch, and
[AGENTS.md](./AGENTS.md) if an AI agent is doing the work.
