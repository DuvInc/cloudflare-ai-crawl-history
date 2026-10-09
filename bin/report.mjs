#!/usr/bin/env node
/**
 * What machines did with your sites, from the local copy of the archive.
 *
 *   npm run report                                  # every site, last 14 days
 *   npm run report -- --site example.com            # one site, with its top pages
 *   npm run report -- --site example.com --locales fr,de,es
 *   npm run report -- --days 60 --json              # the same, as JSON
 *   npm run demo                                    # the invented sample archive
 *
 * Health is printed before any number, on purpose. For questions this does not
 * answer, point DuckDB at the same files (README, "Ad hoc SQL").
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fromNdjson } from '../lib/archive.mjs';
import { health, isAi, sum, urlParts } from '../lib/report.mjs';
import { flags, ROOT } from './config.mjs';

const opts = flags();
const dir = path.resolve(ROOT, opts.archive ?? '.archive');
const days = Number(opts.days ?? 14);
const now = opts.now ? new Date(opts.now) : new Date();
const site = typeof opts.site === 'string' ? opts.site : undefined;
const locales = typeof opts.locales === 'string' ? opts.locales.split(',').map((s) => s.trim()).filter(Boolean) : [];
const firstDay = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

if (!existsSync(path.join(dir, '_ledger.json'))) {
  console.error(`No archive in ${dir}. Run \`npm run pull\` first, or \`npm run demo\` for the sample.`);
  process.exit(1);
}
const ledger = JSON.parse(readFileSync(path.join(dir, '_ledger.json'), 'utf8'))
  .filter((r) => r.hour.slice(0, 10) >= firstDay && (!site || r.zone === site || r.zone === '*'));

/* Read every file of the range. The zone is the first path segment. */
function load(table) {
  const rows = [];
  for (const zone of readdirSync(dir).filter((z) => !z.startsWith('_') && (!site || z === site))) {
    const base = path.join(dir, zone, table);
    if (!existsSync(base)) continue;
    for (const day of readdirSync(base).filter((d) => d >= firstDay)) {
      for (const file of readdirSync(path.join(base, day)).filter((f) => f.endsWith('.ndjson.gz'))) {
        for (const row of fromNdjson(gunzipSync(readFileSync(path.join(base, day, file))).toString('utf8'))) {
          rows.push({ zone, ...row });
        }
      }
    }
  }
  return rows;
}
const crawl = load('crawl');
const totals = load('totals');

const h = health(ledger, { now, days });
const daysCollected = new Set(crawl.map((r) => r.day)).size || 1;
const share = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '');

const sections = [];
const section = (title, rows, note) => sections.push({ title, rows, note });

section('Collection health', h.sites.map((s) => ({
  site: s.site, since: s.since, complete_hours: s.hours, failed_runs: s.failed,
  state: [s.missing && `${s.missing} h missing`, s.partial_hours && `${s.partial_hours} h partial`].filter(Boolean).join(', ') || 'ok',
})), 'A window missing for longer than your plan keeps the detail is lost for good.');
if (h.problems.length > 0) {
  section('Latest failed or partial windows', h.problems.slice(0, 8).map((r) => ({
    site: r.zone, window: r.hour, status: r.status, note: String(r.note ?? '').slice(0, 80),
  })));
}

if (!site) {
  const zones = sum(crawl, ['zone']);
  section('Per site', zones.map(({ zone, requests }) => {
    const own = crawl.filter((r) => r.zone === zone);
    const ai = own.filter(isAi).reduce((n, r) => n + r.requests, 0);
    return {
      site: zone, verified_bots: requests, ai: ai, ai_share: share(ai, requests),
      twins: own.filter((r) => r.kind === 'twin').reduce((n, r) => n + r.requests, 0),
      llms_txt: own.filter((r) => r.kind === 'llms').reduce((n, r) => n + r.requests, 0),
      bots: new Set(own.map((r) => r.bot_name)).size,
    };
  }));
}

section('AI crawlers', sum(crawl, ['bot_name', 'bot_category'], { where: isAi, distinct: 'path', limit: 15 })
  .map((r) => ({ ...r, per_day: Math.round(r.requests / daysCollected) })));

section('What AI crawlers fetch, by kind', sum(crawl, ['kind'], { where: isAi, distinct: 'path' }),
  'twin = a Markdown twin (.md), llms = llms.txt. Zero is an answer too.');

/* The GEO question in one table: of the pages a bot read, how often did it
   take the Markdown twin rather than the HTML? */
const twinShare = sum(crawl, ['bot_name'], { where: (r) => isAi(r) && (r.kind === 'twin' || r.kind === 'page') })
  .map(({ bot_name, requests }) => {
    const twins = crawl.filter((r) => r.bot_name === bot_name && r.kind === 'twin').reduce((n, r) => n + r.requests, 0);
    return { bot_name, pages_and_twins: requests, twins, twin_share: share(twins, requests) };
  }).slice(0, 12);
if (twinShare.some((r) => r.twins > 0)) section('Who takes the Markdown twins', twinShare);

section('AI crawler requests per day', sum(crawl, ['day'], { where: isAi, distinct: 'bot_name' })
  .sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 30),
'Compare days, not sums over ranges of different length.');

section('All verified bots, by category', sum(crawl, ['bot_category'], { distinct: 'bot_name' }));

if (site) {
  section('Pages AI crawlers read most', sum(crawl, ['path'], { where: isAi, distinct: 'bot_name', limit: 20 }));
  const sectionOf = Object.assign((r) => urlParts(r.path, { locales }).section || '(root)', { label: 'section' });
  section('Sections', sum(crawl, [sectionOf, 'kind'], { where: (r) => r.kind === 'page' || r.kind === 'twin', limit: 20 }));
  if (locales.length > 0) {
    const localeOf = Object.assign((r) => urlParts(r.path, { locales }).locale || '(default)', { label: 'locale' });
    section('AI crawling by locale', sum(crawl, [localeOf], { where: (r) => isAi(r) && (r.kind === 'page' || r.kind === 'twin') }),
      'Pages and twins only: assets and feeds have no locale and would inflate the default.');
  }
}

section('Crawl spent on errors and redirects', sum(crawl, [...(site ? [] : ['zone']), 'status'], {
  where: (r) => r.status !== 200, distinct: 'path', limit: 15,
}));

section('Machine share of traffic', sum(totals, [...(site ? [] : ['zone']), 'kind'], { limit: 20 }).map((r) => {
  const bots = totals.filter((t) => (site || t.zone === r.zone) && t.kind === r.kind && t.audience === 'bot')
    .reduce((n, t) => n + t.requests, 0);
  return { ...r, verified_bots: bots, bot_share: share(bots, r.requests) };
}), "'other' is not 'human': unverified crawlers land there too. Read it as an upper bound.");

if (opts.json) {
  console.log(JSON.stringify({ range: { days, from: firstDay, now: now.toISOString() }, healthy: h.healthy, sections }, null, 1));
  process.exit(0);
}

function table(rows) {
  if (rows.length === 0) { console.log('    (no data)'); return; }
  const keys = Object.keys(rows[0]);
  const width = Object.fromEntries(keys.map((k) => [k, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length))]));
  const num = (k) => rows.every((r) => typeof r[k] === 'number');
  const cell = (k, v) => (num(k) ? String(v ?? '').padStart(width[k]) : String(v ?? '').padEnd(width[k]));
  console.log('    ' + keys.map((k) => cell(k, k)).join('  '));
  console.log('    ' + keys.map((k) => '-'.repeat(width[k])).join('  '));
  for (const row of rows) console.log('    ' + keys.map((k) => cell(k, row[k])).join('  '));
}

console.log(`\nLast ${days} days, ${site ?? 'all sites'}. ${crawl.length} crawl rows, ${totals.length} totals rows.`);
for (const s of sections) {
  console.log(`\n== ${s.title} ==\n`);
  table(s.rows);
  if (s.note) console.log(`\n    ${s.note}`);
}
console.log('');
