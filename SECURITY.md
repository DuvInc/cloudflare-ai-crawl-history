# Security policy

## Reporting a vulnerability

Please report privately rather than in a public issue, using GitHub's
[private vulnerability reporting](https://github.com/DuvInc/cloudflare-ai-crawl-history/security/advisories/new)
on this repository.

This is a one-person project. You should get an acknowledgement within a few
days; if a week passes with no reply, feel free to nudge by opening a public
issue that says only that you are waiting on a private report, with no details.

## What is in scope

A Worker holding a read token for your analytics, with bindings that can write
an R2 bucket and a D1 database. The interesting surface:

- **The token.** Anything that causes `CF_ANALYTICS_TOKEN` to be logged,
  written to R2 or D1, sent anywhere other than `api.cloudflare.com`, or
  printed by a script in `bin/`. `lib/cloudflare.mjs` is the only file that
  should ever use it, and `bin/create-token.sh` must never echo it.
- **Any way to reach the Worker over HTTP.** It is cron-only by design: no
  `fetch` export, `workers_dev: false`, `preview_urls: false`. A change that
  makes it addressable is in scope whether or not it is exploitable.
- **What gets stored.** No IPs, no raw User-Agent, no per-path record of
  non-bot traffic. A change that starts storing more personal data is in
  scope.
- **Untrusted input in the archive.** Paths and User-Agents come from
  whoever sent the request. They reach JSON files and the terminal, and in a
  read API they would reach SQL and HTML. A path crafted to break a key
  (`keyFor` validates the zone name) or a query built by string concatenation
  from archive content is the bug to look for.
- **The local scripts.** `bin/pull.mjs` writes files named after ledger rows.
  A ledger row that makes it write outside `.archive/` is in scope.

## What is out of scope

- Cloudflare itself: its API, its bot verification, its dashboard. Report
  those to Cloudflare.
- Data quality. A wrong count or a misnamed bot is a bug, not a vulnerability.
- The read APIs in `docs/read-api.md`. They are described, not shipped. If you
  build one and find a flaw in the design, a regular issue is welcome.
- A vulnerability that requires the attacker to already have access to your
  Cloudflare account or your machine.

## If you deployed this

Three things this repository cannot do for you:

- **Scope the token.** Zone > Zone > Read and Zone > Analytics > Read, on the
  listed zones only. A broader token works too, which is why it is tempting.
- **Rotate it.** No TTL is set by `create-token.sh`, because an expired token
  produces failed runs and lost windows. Rotate it yourself when someone with
  access leaves.
- **Keep it out of transcripts.** If an AI agent ever printed or handled the
  token, consider it leaked and create a new one. That is why the script
  exists.

## If you forked this tool

Replace the link above with your own repository. This file arrived with the
code and points at somebody else's advisories.
