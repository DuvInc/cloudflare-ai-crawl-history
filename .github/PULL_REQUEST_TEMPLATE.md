## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- What was collected wrongly, lost, or impossible to ask before. -->

## Checklist

- [ ] `npm test` passes locally
- [ ] Commits are signed off (`git commit -s`); see CONTRIBUTING.md
- [ ] If `lib/collect.mjs`, `lib/archive.mjs` or `lib/fold.mjs` changed: a test shows the new behaviour
- [ ] If the queries, the split or the windows changed: the site size and the ledger results are in the description
- [ ] If `shape()`, `kindOf` or `botName` changed: `node demo/make-sample.mjs` was re-run and the README excerpt still matches
- [ ] `lib/` is still pure outside `lib/cloudflare.mjs`: no env var, no fetch, no log
- [ ] The collector Worker still exports `scheduled` only
- [ ] No new dependency, or it was discussed in an issue first
- [ ] No token and no real archive file in this diff
