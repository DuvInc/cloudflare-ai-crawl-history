# Reading the archive without fooling yourself

The collector is the easy part. The mistakes that cost the most were made
afterwards, reading the data, and none of them looked wrong at the time.

## 1. What it can answer, and what it never will

It can answer: which verified bot, how many requests, which path, which kind
(page, twin, llms, feed, asset), which country, which HTTP status, per four
hour window. With a locale list, which locale and which section.

It **cannot** answer, however the query is written:

- **How a bot found a URL.** There is no referer. Cloudflare refuses
  `clientRequestReferer` and `clientRefererHost` below the Enterprise tier
  ("zone does not have access to the field"). No SQL recovers a field that was
  never collected.
- **The order things happened in.** Rows are counts per window, not a request
  log. "Did it read the HTML and then the twin" has no answer here: there is
  no timestamp finer than the window and no request id.

When a question has that shape, say it cannot be answered and why, before
offering anything else. If you want discovery data, tag your own links (a
`?ref=` on the internal links to your twins) and the path will carry it.

## 2. A correlation that moves when you tighten it is noise

What happened: "same day" co-occurrence of a bot's twin fetches and HTML
fetches of the same page gave ClaudeBot 60%. The same question at "same hour"
gave 2%. One condition changed, the answer moved by 30x.

That instability is the finding. Before reporting any correlation, compute it
at two granularities. If they disagree by more than about 2x, the result is
"this method is unreliable at this sample size", not whichever number was
computed first.

The same query was also expensive: a self-join on `path || '.md'` cannot use
an index, and while the archive still lived in D1, about 110 runs of it read
692 million rows in one afternoon. In files, read locally, it costs nothing,
which is one more reason the data is in files.

## 3. `SUM(requests)`, never `COUNT(*)`

A row is a group: one (window, host, path, bot, country, status)
combination with its count already summed. `COUNT(*)` counts combinations. It
is a real number, and almost never the one being asked for.

```sql
-- wrong: counts groups
SELECT bot_name, COUNT(*) FROM crawl WHERE kind = 'twin' GROUP BY 1;
-- right: counts requests
SELECT bot_name, SUM(requests) FROM crawl WHERE kind = 'twin' GROUP BY 1;
```

If a new total does not reconcile with one already reported for the same
slice, find out why before showing it.

## 4. Never compare sums over ranges of different length

"ClaudeBot rose this week" from a 7 day sum against a 5 day sum is a
statement about the calendar. Divide by days actually collected, which the
health table gives you. A real case: ClaudeBot was down 72% day over day
while the raw totals over the two ranges "rose".

## 5. Category is verified, name is not

`bot_category` comes from Cloudflare's verification: the request came from an
IP range the operator publishes. `bot_name` is parsed from the User-Agent of
that verified request. So the category is the fact and the name is a label.
On one day, by category: AI Crawler 503, Search Engine Crawler 404, AI Search
225. By name, the biggest was `meta-externalagent` with 252, ClaudeBot 37,
GPTBot 2. Both are true; they answer different questions.

## 6. `other` is not human

The totals table splits traffic into `bot` (verified) and `other`.
Unverified crawlers, scrapers and scanners are all in `other`. Read it as an
upper bound on human traffic. Your web analytics, not this archive, is the
place for human numbers.

## 7. Locale splits: pages and twins only

Assets, feeds and `llms.txt` have no locale prefix, so they land in the
default language and inflate it. Filter to `kind IN ('page', 'twin')` before
any locale comparison.

## 8. Health before numbers

`npm run report` prints collection health first. A window that was not
collected before your plan's retention ran out is gone, and a total over a
range with holes looks exactly like a total. Read the health table, then the
numbers, every time.
