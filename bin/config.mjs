/**
 * Shared by the scripts in `bin/`: the deployed config, the local wrangler,
 * and `.env`. Not part of the library.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../lib/jsonc.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');

/* A real environment variable always wins over the file. */
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

export function config() {
  const raw = parseJsonc(readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const d1 = raw.d1_databases?.[0] ?? {};
  return {
    accountId: raw.vars?.CF_ACCOUNT_ID,
    sites: raw.vars?.SITES ?? [],
    bucket: raw.r2_buckets?.[0]?.bucket_name,
    database: d1.database_name,
    databaseId: d1.database_id,
    windowHours: Number(raw.vars?.WINDOW_HOURS) || 4,
  };
}

/* `node_modules/.bin/wrangler`, not `npx`: one to two seconds less per call,
   and the pull makes one call per file. */
const LOCAL = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
export const WRANGLER = existsSync(LOCAL) ? LOCAL : 'wrangler';

export function wrangler(args, options = {}) {
  return execFileSync(WRANGLER, args, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options,
  });
}

export function flags(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else { out[name] = next; i += 1; }
  }
  return out;
}
