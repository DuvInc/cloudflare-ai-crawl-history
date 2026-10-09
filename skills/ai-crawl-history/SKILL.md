---
name: ai-crawl-history
description: Set up, extend, check and read a long-term archive of Cloudflare's verified AI crawler traffic (GPTBot, ClaudeBot, PerplexityBot...) per site and per page. Use when a user wants AI bot or AI Crawl Control analytics kept longer than their plan allows, wants to add a site to the archive, sees a gap or failed window, or asks a GEO/AEO question such as which bots read which pages, whether agents take Markdown twins or llms.txt, or how AI crawling changed over time.
---

# Keeping and reading AI crawler history

The procedure. The reasoning is in `AGENTS.md`, the evidence and the costs in
`README.md`, the reading traps in `docs/reading-the-archive.md`.

## 1. Setting it up

1. Check the prerequisites before anything else: the zones are on Cloudflare
   and proxied, and the account has **Workers Paid**. On Free, a cron run gets
   10 ms of CPU and 50 subrequests, and the collector will fail.
2. `npm install`, `npx wrangler login`, `npm run setup`. Put the D1 id, the
   account id and the `SITES` list in `wrangler.jsonc`. `npm run schema`.
3. **The token is the user's job, never yours.** Give them
   `bash bin/create-token.sh`, or the dashboard steps from the README. Do not
   ask for the value, do not read it from a file, do not pass it on a command
   line you run. If a token ever appears in your context, tell the user to
   revoke it.
4. `npm run preflight` must pass, and it prints what each zone's plan keeps.
   Say that number to the user: it decides how long a broken collector can
   stay broken before data is lost.
5. `npm run deploy`, after asking. Suggest the five minute cron test from the
   README before trusting it.

## 2. Adding a site

A line in `SITES`, then the user re-runs `bash bin/create-token.sh` (the new
token covers every listed zone; they delete the old one), then
`npm run preflight`, then `npm run deploy`. Add `since` only if that site's
history was imported from another collector, set to the first window this one
owns.

## 3. Reading it

```bash
npm run pull
npm run report                                   # all sites
npm run report -- --site example.com --locales fr,de
npm run report -- --json                         # for further processing
```

Report, in this order:

1. **Health.** Hours covered, missing, partial, failed runs. If anything is
   missing, say so first and say whether it is still recoverable (inside the
   plan's retention) or gone.
2. **The answer**, with `SUM(requests)` and the number of days it covers.
3. **What the archive cannot say** when the question touches it: how a bot
   found a page (no referer), the order of requests (counts per window), or
   human traffic (`other` is an upper bound).

For anything the report does not cover, use DuckDB on `.archive/` (README,
"Ad hoc SQL"). Before quoting a correlation, compute it at two granularities;
if they disagree by more than 2x, report that the method is unreliable, not
either number.

## 4. Diagnosing a gap

Read the ledger first: `npm run pull` writes it to `.archive/_ledger.json`.

| `note` says | Cause | Fix |
| :--- | :--- | :--- |
| `CF_ANALYTICS_TOKEN is not set` | secret missing | user runs `bin/create-token.sh` |
| `zone not visible to the token` | zone not on the token | user re-runs `bin/create-token.sh` |
| `does not have access to the field` | a dimension the plan does not offer | remove it from `lib/cloudflare.mjs` |
| `group cap` and `partial` | the window is still full at 15 minutes | bots: a real problem, raise it; totals only: denominators are short, say so |
| D1 `7403` in pull | often transient | retry once |
| zone `*`, `failed` | the run failed before any site | read the note: usually the token |

The collector repairs itself on the next run for anything still inside the
horizon. A window older than the plan's retention is gone; say so plainly.

## 5. Giving someone else access

Do not add a `fetch` handler to the collector. Point the user at
`docs/read-api.md` and recommend the smallest option that fits: an R2
read-only token and DuckDB for one analyst, a small read Worker with fixed
endpoints for a dashboard, SQL over a container only for a team or an agent
that needs to explore.
