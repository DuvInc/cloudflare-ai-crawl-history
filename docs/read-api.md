# Giving someone else access to the archive

This repository ships no HTTP API on purpose. The collector exports
`scheduled` and nothing else, and you read the archive through your own
wrangler session (`npm run pull`). With one reader, an endpoint is attack
surface and nothing more, and the only caller already has `wrangler login`.

That changes when the reader is a teammate, a dashboard, an agent, or a
product. Below are three ways to do it, from the least code to the most. The
third one is running in production on a sibling deployment that serves
several sites to a team. Its code is not in this repository, but every
decision that mattered is written down here.

Whichever you pick, **never add a `fetch` handler to the collector itself.**
It holds a token that can read your analytics and bindings that can write your
archive. A reader gets its own Worker, with its own read-only bindings, or no
Worker at all.

## 1. No Worker: a read-only R2 token and DuckDB

R2 speaks the S3 API, and DuckDB reads S3 directly. Create an R2 API token
with **Object Read only**, scoped to this one bucket (dashboard, R2,
Manage API tokens), and hand over four values. Then, on their machine:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET archive (
  TYPE r2, KEY_ID '<access key id>', SECRET '<secret access key>', ACCOUNT_ID '<account id>'
);

SELECT regexp_extract(filename, '([^/]+)/crawl/', 1) AS zone,
       bot_name, SUM(requests) AS requests
FROM read_json('r2://ai-crawl-history/*/crawl/*/*.ndjson.gz', filename = true)
WHERE day >= '2026-10-01' AND bot_category LIKE 'AI%'
GROUP BY ALL ORDER BY requests DESC;
```

Unlike wrangler, the S3 API can list, so the glob works and no ledger is
needed to find the files. What they lose is the health check: give them read
access to the ledger too, or tell them to treat a day with fewer than six
files per table as incomplete.

Cost: R2 class B reads, ten million a month free. A glob over a year is
about 4,400 objects per site.

Good for: one analyst, a notebook, an agent with a shell.
Not for: a browser. The secret would ship to every visitor.

## 2. A small read Worker with fixed endpoints

For a dashboard or a product page, fixed questions, no SQL. A second Worker
with the R2 bucket and the D1 ledger bound, a `fetch` handler, and nothing
that can write.

```text
GET /health?days=30                 the ledger, summarised: covered, missing, partial
GET /bots?site=example.com&days=30  requests per bot_name and bot_category
GET /pages?site=example.com&days=7  top paths read by AI crawlers
GET /twins?site=example.com         twin share per bot
```

Each endpoint reads the files of its range from R2, aggregates them in the
Worker with the functions in `lib/report.mjs`, and caches the result. Thirty
days of one site is 180 files of a few kilobytes each: well within one
invocation on Workers Paid.

The parts that are easy to get wrong, all taken from the production API:

- **Authentication before routing, and every failure is a bare 404.** Not a
  401: a 401 tells a scanner the endpoint exists. An unset secret also returns
  404, so a deploy that forgot it fails closed.
- **Compare the token in constant time.** `===` on strings returns early on
  the first different byte.

  ```js
  function tokenMatches(given, expected) {
    const a = new TextEncoder().encode(given);
    const b = new TextEncoder().encode(expected);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
  }
  const presented = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  ```

- **The read token is not the analytics token.** A separate random secret
  (`openssl rand -hex 32`, then `wrangler secret put API_TOKEN` on the read
  Worker). The read Worker never has `CF_ANALYTICS_TOKEN` at all.
- **Narrow the environment.** Pass the handler only the bindings it needs
  (`{ ARCHIVE, DB, API_TOKEN }`), so no future route can reach anything else
  by accident.
- **Cache on the question, never on the token.** Key the Cache API on the
  route plus its parameters, send `cache-control: private`, and offer
  `?fresh=1` to bypass. An hour is right for anything but `/health`, which
  should be five minutes.
- **Answer health with the data.** Every response carries the covered and
  missing hours of its range, so a chart with a hole in it says so.
- **CORS only if a browser calls it, and then one origin, never `*`.** The
  production API sends no CORS headers at all, because its callers are
  servers.

Cost: one Worker request per call, plus the R2 reads on a cache miss. Free at
any realistic volume.

## 3. SQL over HTTP: DuckDB in a Container

When the callers need arbitrary questions (an agent exploring, a team asking
things nobody planned), the production deployment answers SQL. The Worker
validates the query, then forwards it to a Durable Object that drives a
Cloudflare Container running DuckDB. The container syncs the archive files
from R2 to its disk and queries them locally.

```text
GET  /                 usage, rules, and the allowed SQL vocabulary
GET  /schema           tables, column descriptions, distinct values of the low-cardinality columns
GET  /health?days=N    from D1 only: never wakes the container
GET  /query?sql=...    or POST {"sql": "..."}
     -> { meta: { rows, truncated, max_rows, ms, sql }, rows: [...] }
```

What made it safe enough to expose:

- **An allowlist, not a blocklist.** String literals are stripped first, then
  the query is refused if it has a comment, a `;`, a character outside a small
  set, or does not start with `SELECT` or `WITH`. Every remaining identifier
  must be a known keyword, function, table or column, or be declared with
  `AS` or as a CTE name. A quoted string after `FROM` or `JOIN` is refused
  explicitly: DuckDB reads it as a file path.
- **The row cap is measured.** The query runs as
  `SELECT * FROM (<query>) LIMIT 5001`, so the response can say
  `truncated: true` instead of guessing. No pagination: callers are told to
  aggregate.
- **The engine is locked down after it loads the views.**
  `enable_external_access = false`, `allowed_directories` set to the archive,
  600 MB of memory, one thread, then `lock_configuration`. Each statement is
  interrupted after 20 seconds. The container has no internet: its only
  outbound host is an internal name the Worker answers with R2 objects, behind
  a strict key regex.
- **Engine errors and query errors are different statuses.** 503 when the
  container is down, 400 when the SQL is wrong, so a caller knows whether to
  retry or rewrite.
- **`/schema` lists the real values.** Up to 200 distinct values for `zone`,
  `bot_category`, `bot_name`, `kind` and `status`. Agents write far better
  queries when they can see that the category is `AI Crawler` and not `ai`.

What it costs, measured: a cold query takes about 6 seconds while the
container starts and syncs. It sleeps after a minute of inactivity. Normal use
is about $0; the worst case, a container kept awake all month, is $6 to $10.

Production bugs worth knowing before you build one:

- The Worker must `export { ContainerProxy }` from `@cloudflare/containers`,
  or every query returns 503.
- The outbound handler must buffer R2 bodies, not stream them. Streaming
  failed intermittently during a 94 file cold sync.
- Overriding `onActivityExpired` without calling `stop()` means the container
  never sleeps, and the worst case becomes the normal case.
- Deploying from Apple Silicon needs `docker buildx`.

Good for: a team, an agent with no shell, anything exploratory.
Not for: a public page. Put option 2 in front of it, or precompute.
