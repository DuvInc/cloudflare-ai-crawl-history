#!/usr/bin/env node
/**
 * Builds `demo/sample-archive/`: seven days of two invented sites, in the
 * exact layout the collector writes. Every number in it is made up.
 *
 * It fabricates raw API groups (User-Agent strings, paths, statuses) and runs
 * them through the library's own `shape()`, so the sample also exercises the
 * real classification and fold. One window is missing and one is partial on
 * purpose: the report has to show them before any total.
 *
 *   node demo/make-sample.mjs     # deterministic, safe to re-run
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { keyFor, shape, toNdjson } from '../lib/archive.mjs';
import { botName, kindOf } from '../lib/classify.mjs';
import { hourKey, HOUR_MS } from '../lib/windows.mjs';

const OUT = path.join(import.meta.dirname, 'sample-archive');
const END = Date.parse('2026-10-10T08:00:00Z');
const START = END - 7 * 24 * HOUR_MS;

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (list) => list[Math.floor(rand() * list.length)];

const BOTS = [
  { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)', cat: 'AI Crawler', rate: 9, twin: 0.4 },
  { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', cat: 'AI Crawler', rate: 7, twin: 0.5 },
  { ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', cat: 'AI Crawler', rate: 14, twin: 0 },
  { ua: 'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)', cat: 'AI Crawler', rate: 4, twin: 0.25 },
  { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', cat: 'AI Search', rate: 3, twin: 0.1 },
  { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot', cat: 'AI Search', rate: 2, twin: 0.05 },
  { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', cat: 'AI Assistant', rate: 1, twin: 0 },
  { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', cat: 'Search Engine Crawler', rate: 12, twin: 0 },
  { ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', cat: 'Search Engine Crawler', rate: 6, twin: 0 },
];

const SITES = {
  'example.com': { host: 'example.com', pages: ['/', '/pricing', '/blog/why-files', '/blog/cron-windows', '/docs/setup', '/docs/api', '/fr/docs/setup', '/de/docs/setup', '/changelog'] },
  'example.org': { host: 'www.example.org', pages: ['/', '/guides/getting-started', '/guides/limits', '/guides/faq', '/es/guides/getting-started', '/about'] },
};

const ledger = [];
rmSync(OUT, { recursive: true, force: true });

for (const [zone, site] of Object.entries(SITES)) {
  for (let t = START; t < END; t += 4 * HOUR_MS) {
    const hour = hourKey(t);
    /* One window the collector never got: the token was revoked for a day. */
    if (zone === 'example.org' && hour === '2026-10-07T12') {
      ledger.push({ zone, hour, span_hours: 4, ran_at: '2026-10-08T08:07:12.000Z', status: 'failed', rows: 0, groups: 0, note: 'GraphQL: not authorized for that account' });
      continue;
    }
    const botRows = [];
    const allRows = [];
    const growth = 1 + (t - START) / (7 * 24 * HOUR_MS);
    for (const bot of BOTS) {
      const n = Math.round(bot.rate * growth * (0.6 + rand()) * (zone === 'example.org' ? 0.5 : 1));
      for (let i = 0; i < n; i += 1) {
        const page = pick(site.pages);
        let p = page;
        const r = rand();
        if (r < bot.twin) p = page === '/' ? '/index.md' : `${page}.md`;
        else if (r < bot.twin + 0.08) p = pick(['/robots.txt', '/sitemap.xml', '/llms.txt', '/_astro/app.4f2a.css']);
        const status = p.startsWith('/llms') && zone === 'example.org' ? 404 : rand() < 0.05 ? pick([404, 301]) : 200;
        const dims = {
          clientRequestHTTPHost: site.host, clientRequestPath: p, userAgent: bot.ua,
          verifiedBotCategory: bot.cat, clientCountryName: pick(['US', 'US', 'US', 'IE', 'SE']), edgeResponseStatus: status,
        };
        botRows.push({ count: 1 + Math.floor(rand() * 3), dimensions: dims });
      }
    }
    allRows.push(...botRows);
    for (let i = 0; i < 40; i += 1) {
      allRows.push({ count: 1 + Math.floor(rand() * 9), dimensions: {
        clientRequestHTTPHost: site.host, clientRequestPath: pick([...site.pages, '/_astro/app.4f2a.css', '/favicon.ico', '/wp-login.php', '/.env']),
        userAgent: 'Mozilla/5.0', verifiedBotCategory: '', clientCountryName: 'FR', edgeResponseStatus: 200,
      } });
    }
    const { crawl, totals } = shape({ hour, botRows, allRows, kindOf, botName });
    for (const [table, rows] of [['crawl', crawl], ['totals', totals]]) {
      const file = path.join(OUT, keyFor(zone, table, hour));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, gzipSync(toNdjson(rows), { level: 9 }));
    }
    const partial = zone === 'example.com' && hour === '2026-10-09T08';
    ledger.push({
      zone, hour, span_hours: 4, ran_at: new Date(t + 4 * HOUR_MS + 7 * 60_000).toISOString(),
      status: partial ? 'partial' : 'ok', rows: crawl.length, groups: partial ? 10000 : allRows.length,
      note: partial ? 'totals query hit the 10000 group cap: only the totals are short' : '',
    });
  }
}

writeFileSync(path.join(OUT, '_ledger.json'), JSON.stringify(ledger, null, 1));
console.log(`Wrote ${ledger.length} windows to ${path.relative(process.cwd(), OUT)}/`);
