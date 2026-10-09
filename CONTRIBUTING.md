# Contributing

Thanks for looking. This is a one-person project maintained on a best-effort
basis, so the most useful thing you can do before writing code is open an
issue. A small fix is always welcome; a large one is worth agreeing on first.

## Getting set up

Node 22.18 or newer.

```bash
npm test        # 38 tests, no network, no token, no npm install needed
npm run demo    # the report on the invented sample archive
```

`npm test` passes on a fresh clone with nothing installed. If it does not,
that is a bug worth reporting on its own. `npm install` only brings wrangler,
which you need to deploy and nothing else.

To exercise the real path you need a Cloudflare account with Workers Paid and
at least one zone. The README's setup takes about fifteen minutes, and the
collector costs nothing beyond the $5 plan.

## Sign your commits off

Every commit needs a `Signed-off-by` line, which certifies that you wrote the
patch or otherwise have the right to submit it under the MIT licence. This is
the [Developer Certificate of Origin](https://developercertificate.org): one
line, no paperwork, no copyright assignment.

```bash
git commit -s -m "Your message"
```

## What makes a change likely to be merged

**A collector change comes with a test.** `lib/collect.mjs`, `lib/archive.mjs`
and `lib/fold.mjs` are where silent data loss would come from. Several tests
exist because of a bug that shipped once; if you change what is collected,
split, folded or marked, add the case that shows the new behaviour.

**The purity boundary holds.** `lib/cloudflare.mjs` is the only file that
opens a socket. Everything else takes its source, store, ledger and clock as
arguments. A change that reads `process.env` or calls `fetch` elsewhere in
`lib/` makes the tests harder to trust.

**The collector stays cron-only.** No `fetch` handler in `worker/`. A read
API is welcome as a separate Worker, discussed in an issue first; see
`docs/read-api.md`.

**No new dependency.** wrangler is the only one. Anything else needs an
argument in an issue.

**Report what you measured.** For a change to the queries, the split or the
windows, say on what site size you ran it (distinct paths, groups per window)
and what the ledger showed. "Works for me" on a ten page site says nothing
about the 10,000 group cap.

**A change to `shape()`, `kindOf` or `botName` regenerates the sample.**
`node demo/make-sample.mjs`, then check that the README excerpt still matches
`npm run demo`.

**Comments explain why, not what.** The existing ones are long on purpose:
they record what went wrong before.

**No em dashes**, anywhere.

## Reporting a bug

Include the commit, your plan, the number of sites, and the relevant rows of
the ledger (`collector_runs`: hour, status, groups, note). Most collector bugs
show there first.

Do not paste a token, and do not paste real archive files. Site names and
paths are fine if they are already public; otherwise replace them.

For anything with security implications, read [SECURITY.md](./SECURITY.md)
instead of opening a public issue.
