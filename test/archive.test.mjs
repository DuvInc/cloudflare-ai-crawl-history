import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromNdjson, gunzip, gzip, keyFor, shape, toNdjson } from '../lib/archive.mjs';
import { botName, kindOf } from '../lib/classify.mjs';
import { fold } from '../lib/fold.mjs';
import { parseJsonc } from '../lib/jsonc.mjs';

const group = (count, d) => ({
  count,
  dimensions: {
    clientRequestHTTPHost: 'example.com', clientRequestPath: '/', userAgent: 'x', verifiedBotCategory: '',
    clientCountryName: 'US', edgeResponseStatus: 200, ...d,
  },
});

test('keys: one file per site, table and window', () => {
  assert.equal(keyFor('example.com', 'crawl', '2026-10-10T04'), 'example.com/crawl/2026-10-10/04.ndjson.gz');
  assert.throws(() => keyFor('../etc', 'crawl', '2026-10-10T04'));
  assert.throws(() => keyFor('example.com', 'logs', '2026-10-10T04'));
  assert.throws(() => keyFor('..', 'crawl', '2026-10-10T04'));
  assert.throws(() => keyFor('example.com', 'crawl', '../../../x/T04'), 'a ledger row cannot point outside the archive');
});

test('gzip round trip, with the format the collector writes', async () => {
  const rows = [{ a: 1, path: '/x y' }, { a: 2, path: '/é' }];
  assert.deepEqual(fromNdjson(await gunzip(await gzip(toNdjson(rows)))), rows);
  assert.equal(toNdjson([]), '');
});

/* Folding on the raw User-Agent while storing the normalised name once wrote
   two lines for one bot and inflated every COUNT(*) downstream. */
test('two User-Agents for one bot become one line, counts summed', () => {
  const { crawl } = shape({
    hour: '2026-10-10T04', kindOf, botName, allRows: [],
    botRows: [
      group(3, { userAgent: 'Mozilla/5.0 (compatible; GPTBot/1.1)', verifiedBotCategory: 'AI Crawler' }),
      group(4, { userAgent: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', verifiedBotCategory: 'AI Crawler' }),
    ],
  });
  assert.equal(crawl.length, 1);
  assert.equal(crawl[0].bot_name, 'GPTBot');
  assert.equal(crawl[0].requests, 7);
});

test('the crawl table keeps verified bots only; totals keep everything, as bot or other', () => {
  const rows = [group(5, { verifiedBotCategory: 'AI Crawler', userAgent: 'ClaudeBot' }), group(9, {})];
  const { crawl, totals } = shape({ hour: '2026-10-10T04', kindOf, botName, botRows: rows, allRows: rows });
  assert.equal(crawl.length, 1);
  assert.deepEqual(totals.map((t) => [t.audience, t.requests]).sort(), [['bot', 5], ['other', 9]]);
  assert.ok(!('userAgent' in crawl[0]), 'the raw User-Agent is not stored');
});

test('fold: a path with a space does not collide with two fields', () => {
  const out = fold([
    { a: 'x y', b: 'z', requests: 1 },
    { a: 'x', b: 'y z', requests: 1 },
  ]);
  assert.equal(out.length, 2);
});

test('the fold separator is an escape in the source, never a literal NUL byte', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['lib/fold.mjs', 'lib/report.mjs']) {
    const bytes = await readFile(new URL(`../${file}`, import.meta.url));
    assert.ok(!bytes.includes(0), `${file} contains a NUL byte: git will call it binary`);
  }
});

test('jsonc: comments and trailing commas go, strings stay', () => {
  const parsed = parseJsonc(`{
    // a comment
    "url": "https://example.com/*not a comment*/", /* block */
    "list": [1, 2,],
  }`);
  assert.deepEqual(parsed, { url: 'https://example.com/*not a comment*/', list: [1, 2] });
});
