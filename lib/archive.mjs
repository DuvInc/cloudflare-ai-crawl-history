/**
 * The file format. Gzipped newline-delimited JSON, one file per site, table
 * and window:
 *
 *   <zone>/crawl/<day>/<HH>.ndjson.gz     verified bots, per path
 *   <zone>/totals/<day>/<HH>.ndjson.gz    all traffic, per host, kind, audience
 *
 * Plain files rather than database rows, because this data is append-only and
 * read rarely. In D1 every row is billed once per index it touches: the first
 * version of this collector stored rows in a table with five indexes, wrote
 * ~150,000 billed rows a day for ~25,000 real ones, and was 83% of the
 * account's Cloudflare bill. In R2 a window costs two writes, whatever its size.
 *
 * Runs in Workers and in Node 22: `CompressionStream` is global in both.
 */

import { fold } from './fold.mjs';

export const TABLES = ['crawl', 'totals'];

export const COLUMNS = {
  crawl: ['hour', 'day', 'host', 'path', 'kind', 'bot_category', 'bot_name', 'country', 'status', 'requests'],
  totals: ['hour', 'day', 'host', 'kind', 'audience', 'requests'],
};

export function keyFor(zone, table, hour) {
  if (!TABLES.includes(table)) throw new Error(`unknown table: ${table}`);
  /* Both end up in a file path on the reader's machine (bin/pull.mjs), and
     both come from the ledger: validated, so a bad row cannot write outside
     the archive directory. */
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(zone)) throw new Error(`not a zone name: ${zone}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour)) throw new Error(`not a window key: ${hour}`);
  return `${zone}/${table}/${hour.slice(0, 10)}/${hour.slice(11, 13)}.ndjson.gz`;
}

export function toNdjson(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function fromNdjson(text) {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Turns one window's raw API groups into the two tables. Everything derived
 * here is part of the fold key, so two User-Agents that resolve to one bot
 * name become one line with their counts summed.
 */
export function shape({ hour, botRows, allRows, kindOf, botName }) {
  const day = hour.slice(0, 10);
  const crawl = fold(
    botRows.filter((r) => r.dimensions.verifiedBotCategory).map((r) => {
      const d = r.dimensions;
      return {
        hour, day, host: d.clientRequestHTTPHost ?? '', path: d.clientRequestPath ?? '', kind: kindOf(d.clientRequestPath),
        bot_category: d.verifiedBotCategory, bot_name: botName(d.userAgent),
        country: d.clientCountryName ?? '', status: Number(d.edgeResponseStatus) || 0, requests: Number(r.count) || 0,
      };
    }),
  );
  const totals = fold(
    allRows.map((r) => ({
      hour, day, host: r.dimensions.clientRequestHTTPHost ?? '', kind: kindOf(r.dimensions.clientRequestPath),
      /* `other` is NOT "human": an unverified crawler lands here too. Read it
         as an upper bound on human traffic, never as the number itself. */
      audience: r.dimensions.verifiedBotCategory ? 'bot' : 'other', requests: Number(r.count) || 0,
    })),
  );
  return { crawl, totals };
}
