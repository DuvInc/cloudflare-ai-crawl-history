#!/usr/bin/env node
/**
 * Copies the archive to `.archive/`, so reading it costs nothing on
 * Cloudflare however heavy the query.
 *
 *   npm run pull                 # last 30 days
 *   npm run pull -- --days 90
 *
 * The ledger says which files exist, because wrangler cannot list an R2
 * bucket. It is saved as `.archive/_ledger.json` for the report's health
 * check. A file is downloaded once, and again only if its window was collected
 * again after the local copy was made.
 *
 * Auth is your own wrangler session: there is no endpoint and no second
 * secret. If someone else needs the data, see docs/read-api.md.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { keyFor, TABLES } from '../lib/archive.mjs';
import { config, flags, ROOT, wrangler, WRANGLER } from './config.mjs';

const cfg = config();
const opts = flags();
const days = Number(opts.days ?? 30);
const out = path.resolve(ROOT, opts.archive ?? '.archive');
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 13);

let ledger;
try {
  const raw = wrangler(['d1', 'execute', cfg.database, '--remote', '--json', '--command',
    `SELECT zone, hour, span_hours, ran_at, status, rows, groups, note FROM collector_runs WHERE hour >= '${since}' ORDER BY zone, hour`]);
  ledger = JSON.parse(raw.slice(raw.indexOf('[')))[0]?.results ?? [];
} catch (error) {
  const message = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`;
  if (/not found|does not exist|7403|8000007/i.test(message)) {
    console.error(`\nD1 "${cfg.database}" not reachable. Usual cause: the wrangler session points at another account.` +
      '\nCheck with `npx wrangler whoami`. A transient 7403 also happens: retry once before digging.\n');
    process.exit(1);
  }
  throw error;
}

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, '_ledger.json'), JSON.stringify(ledger, null, 1));

const wanted = [];
for (const r of ledger) {
  if (r.zone === '*' || (r.status !== 'ok' && r.status !== 'partial')) continue;
  for (const table of TABLES) wanted.push({ key: keyFor(r.zone, table, r.hour), ranAt: new Date(r.ran_at).getTime() });
}
const stale = wanted.filter(({ key, ranAt }) => {
  const file = path.join(out, key);
  return !existsSync(file) || statSync(file).mtimeMs < ranAt;
});

console.error(`${ledger.length} ledger rows, ${wanted.length} files, ${stale.length} to download.`);
const get = promisify(execFile);
for (let i = 0; i < stale.length; i += 8) {
  await Promise.all(stale.slice(i, i + 8).map(async ({ key }) => {
    mkdirSync(path.dirname(path.join(out, key)), { recursive: true });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await get(WRANGLER, ['r2', 'object', 'get', `${cfg.bucket}/${key}`, '--file', path.join(out, key), '--remote'], { cwd: ROOT });
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
  }));
  process.stderr.write(`  ${Math.min(i + 8, stale.length)}/${stale.length}\r`);
}
console.error(`\nDone. Now: npm run report`);
