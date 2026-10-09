#!/usr/bin/env node
/**
 * Read-only checks, to run before trusting the cron and every time a site is
 * added. The collector reads windows that age out: a token that cannot see one
 * zone costs that site its history, silently, until someone looks. This is how
 * you look at a time of your choosing.
 *
 *   npm run preflight                          # config, wrangler session, ledger
 *   CF_ANALYTICS_TOKEN=... npm run preflight   # + the token you are about to deploy
 *
 * It also prints what your plan allows, read from the API: how far back the
 * per-path detail goes, the widest single query, and the group cap. Those
 * numbers decide how often the collector must run, and they have changed
 * before. Nothing here writes anything.
 */
import { createSource } from '../lib/cloudflare.mjs';
import { horizonHours } from '../lib/windows.mjs';
import { config, wrangler } from './config.mjs';

const cfg = config();
let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures += 1; console.error(`  FAIL  ${m}`); };
const info = (m) => console.log(`        ${m}`);

console.log(`\nPreflight: ${cfg.sites.length} site(s): ${cfg.sites.map((s) => s.zone).join(', ')}\n`);

/* 1. Placeholders left in the config. */
for (const [name, value] of [['CF_ACCOUNT_ID', cfg.accountId], ['database_id', cfg.databaseId]]) {
  if (!value || value.startsWith('REPLACE_')) bad(`wrangler.jsonc: ${name} is still a placeholder`);
}
if (cfg.sites.some((s) => s.zone === 'example.com')) bad('wrangler.jsonc: SITES still lists example.com');

/* 2. `wrangler login` is one global session. Another project can move it to a
   different account, and the ledger then "does not exist". */
try {
  const who = wrangler(['whoami']);
  if (cfg.accountId && who.includes(cfg.accountId)) ok('wrangler session can reach the account');
  else bad('wrangler is logged in to a different account: run `npx wrangler login`');
} catch (error) {
  bad(`could not read the wrangler session: ${String(error.message).split('\n')[0]}`);
}

/* 3. The ledger table exists. */
try {
  const out = wrangler(['d1', 'execute', cfg.database, '--remote', '--json', '--command',
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collector_runs'"]);
  if (out.includes('collector_runs')) ok(`ledger ${cfg.database}.collector_runs exists`);
  else bad('ledger table missing: run `npm run schema`');
} catch (error) {
  bad(`could not reach D1 ${cfg.database}: ${String(error.message).split('\n')[0]}`);
}

/* 4. The token, if given: every zone visible, every zone's analytics readable. */
const token = process.env.CF_ANALYTICS_TOKEN;
if (!token) {
  info('CF_ANALYTICS_TOKEN not given: token checks skipped.');
  info('Run again as:  CF_ANALYTICS_TOKEN=... npm run preflight');
} else {
  const source = createSource({ token, accountId: cfg.accountId });
  let ids = new Map();
  try { ids = await source.zones(); } catch (error) { bad(`listing zones: ${error.message}`); }
  for (const site of cfg.sites) {
    const id = ids.get(site.zone);
    if (!id) { bad(`${site.zone}: not visible to the token. Add it to the Zone > Zone > Read policy.`); continue; }
    /* The permission that is easy to get wrong: a token can list a zone and
       still be refused its analytics. */
    try {
      const now = Date.now();
      await source.readWindow({ zoneId: id, since: now - 2 * 3_600_000, until: now - 3_600_000, botsOnly: true, limit: 5 });
      ok(`${site.zone}: zone and analytics readable`);
    } catch (error) {
      bad(`${site.zone}: analytics refused (${error.message}). Add Zone > Analytics > Read for this zone.`);
      continue;
    }
    try {
      const limits = await source.limits(id);
      if (!limits) { info(`${site.zone}: plan limits not readable, the collector will look back ${horizonHours(null)} h`); continue; }
      const days = (s) => `${(s / 86400).toFixed(s % 86400 ? 1 : 0)} d`;
      info(`${site.zone}: per-path detail kept ${days(limits.notOlderThan)}, widest query ${days(limits.maxDuration)}, ` +
        `cap ${limits.maxPageSize} groups. The collector looks back ${horizonHours(limits.notOlderThan)} h.`);
    } catch (error) {
      info(`${site.zone}: plan limits not readable (${error.message}), falling back to ${horizonHours(null)} h`);
    }
  }
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed.\n`); process.exit(1); }
console.log('All checks passed.\n');
