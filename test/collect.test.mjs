import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAdaptive, runCollector } from '../lib/collect.mjs';
import { createSource } from '../lib/cloudflare.mjs';

const NOW = new Date('2026-10-10T09:07:00Z');

/** A fake Cloudflare: `groupsPerHour` decides how full a window comes back. */
function fakeSource({ zones = { 'example.com': 'z1' }, notOlderThan = 86_400, groupsPerHour = 10, fail = () => false } = {}) {
  const calls = [];
  return {
    calls,
    async zones() { return new Map(Object.entries(zones)); },
    async limits() { return { notOlderThan, maxDuration: 86_400, maxPageSize: 10_000 }; },
    async readWindow({ zoneId, since, until, botsOnly, limit }) {
      calls.push({ zoneId, since: new Date(since).toISOString(), until: new Date(until).toISOString(), botsOnly });
      if (fail({ zoneId, since })) throw new Error('GraphQL: boom');
      const hours = (new Date(until) - new Date(since)) / 3_600_000;
      const n = Math.min(limit, Math.round(groupsPerHour * hours));
      const rows = Array.from({ length: n }, (_, i) => ({
        count: 1,
        dimensions: {
          clientRequestHTTPHost: 'example.com', clientRequestPath: `/p${i}`, userAgent: 'ClaudeBot/1.0',
          verifiedBotCategory: botsOnly || i % 2 ? 'AI Crawler' : '', clientCountryName: 'US', edgeResponseStatus: 200,
        },
      }));
      return { rows, truncated: rows.length >= limit };
    },
  };
}

function memory() {
  const files = new Map();
  const entries = [];
  const order = [];
  return {
    files, entries, order,
    store: { async put(key, rows) { order.push(`put ${key}`); files.set(key, rows); } },
    ledger: {
      async done() { return new Set(entries.filter((e) => e.status === 'ok').map((e) => `${e.zone} ${e.hour}`)); },
      async mark(e) { order.push(`mark ${e.zone} ${e.hour} ${e.status}`); entries.push(e); },
    },
  };
}

test('collects every due window, two files each, marker after the files', async () => {
  const m = memory();
  const summary = await runCollector({ source: fakeSource(), store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW });
  /* 09:07 minus 20 h is 13:07: the T16, T20, T00 and T04 windows. T12 started
     before the horizon, and T08 is still open. */
  assert.equal(summary.ok, 4);
  assert.equal(m.files.size, 8);
  const firstMark = m.order.findIndex((o) => o.startsWith('mark'));
  assert.deepEqual(m.order.slice(0, firstMark), [
    'put example.com/crawl/2026-10-09/16.ndjson.gz',
    'put example.com/totals/2026-10-09/16.ndjson.gz',
  ]);
});

test('an ok window is never read twice', async () => {
  const m = memory();
  const source = fakeSource();
  await runCollector({ source, store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW });
  const before = source.calls.length;
  const again = await runCollector({ source, store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW });
  assert.equal(source.calls.length, before);
  assert.equal(again.ok, 0);
});

test('the horizon follows what the API says the plan keeps', async () => {
  const m = memory();
  const summary = await runCollector({
    source: fakeSource({ notOlderThan: 3 * 86_400 }), store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW,
  });
  assert.equal(summary.ok, 16, '72 h minus a 4 h margin is 68 h: 16 windows start after the horizon');
});

test('the bots query carries the verified-bot filter, the totals query does not', async () => {
  const m = memory();
  const source = fakeSource();
  await runCollector({ source, store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW });
  assert.deepEqual([...new Set(source.calls.map((c) => c.botsOnly))].sort(), [false, true]);
});

/* A scanner hour once filled the all-traffic query to the cap while bot
   traffic was normal. The split is what recovered it. */
test('a full window is halved until it fits', async () => {
  const source = fakeSource({ groupsPerHour: 3000 });
  const out = await readAdaptive(source.readWindow, {
    zoneId: 'z1', since: '2026-10-10T00:00:00Z', until: '2026-10-10T04:00:00Z', botsOnly: false, limit: 10_000,
  });
  assert.equal(out.truncated, false);
  assert.equal(out.rows.length, 12_000);
  assert.equal(out.queries, 3);
});

test('a window still full at 15 minutes is partial, and says which half', async () => {
  const m = memory();
  const summary = await runCollector({
    source: fakeSource({ groupsPerHour: 1e9 }), store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW, queryBudget: 1000,
  });
  assert.ok(summary.partial > 0);
  assert.match(m.entries.find((e) => e.status === 'partial').note, /crawl rows are missing/);
});

test('one failing site does not stop the next one', async () => {
  const m = memory();
  const summary = await runCollector({
    source: fakeSource({ zones: { 'a.example': 'za', 'b.example': 'zb' }, fail: ({ zoneId }) => zoneId === 'za' }),
    store: m.store, ledger: m.ledger, sites: [{ zone: 'a.example' }, { zone: 'b.example' }], now: NOW,
  });
  assert.equal(summary.failed, 4);
  assert.equal(summary.ok, 4);
  assert.ok(m.entries.filter((e) => e.zone === 'a.example').every((e) => e.status === 'failed' && e.note === 'GraphQL: boom'));
});

test('a zone the token cannot see is recorded, with the permission to add', async () => {
  const m = memory();
  const summary = await runCollector({
    source: fakeSource({ zones: {} }), store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW,
  });
  assert.equal(summary.failed, 1);
  assert.match(m.entries[0].note, /Zone > Analytics > Read/);
});

test('a token that cannot list zones is recorded run-level', async () => {
  const m = memory();
  const source = { ...fakeSource(), async zones() { throw new Error('zones: Invalid API Token'); } };
  await runCollector({ source, store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW });
  assert.equal(m.entries[0].zone, '*');
  assert.equal(m.entries[0].status, 'failed');
});

test('the query budget stops a run cleanly; the next run picks up the rest', async () => {
  const m = memory();
  const source = fakeSource({ notOlderThan: 3 * 86_400 });
  const first = await runCollector({ source, store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW, queryBudget: 9 });
  assert.equal(first.ok, 4, '1 settings query + 4 windows of 2 queries');
  assert.ok(first.skipped > 0);
  assert.equal(first.failed, 0, 'running out of budget is not a failure');
  const second = await runCollector({ source, store: m.store, ledger: m.ledger, sites: [{ zone: 'example.com' }], now: NOW, queryBudget: 1000 });
  assert.equal(first.ok + second.ok, 16);
  assert.deepEqual(m.entries.filter((e) => e.status === 'ok').map((e) => e.hour).slice(0, 2), ['2026-10-07T16', '2026-10-07T20'],
    'oldest first: those are the ones about to age out');
});

test('createSource refuses to start without a token, and sends it as a bearer', async () => {
  assert.throws(() => createSource({}), /no token/);
  const seen = [];
  const source = createSource({
    token: 't0k', accountId: 'acc',
    fetch: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      return new Response(JSON.stringify({ success: true, result: [{ id: 'z1', name: 'example.com' }], result_info: { total_pages: 1 } }));
    },
  });
  assert.deepEqual([...(await source.zones())], [['example.com', 'z1']]);
  assert.equal(seen[0].auth, 'Bearer t0k');
  assert.match(seen[0].url, /account\.id=acc/);
});

test('createSource surfaces a GraphQL error instead of returning an empty window', async () => {
  const source = createSource({
    token: 't',
    fetch: async () => new Response(JSON.stringify({ errors: [{ message: "zone does not have access to the field 'clientrequestreferer'" }] })),
  });
  await assert.rejects(source.readWindow({ zoneId: 'z', since: 0, until: 1, botsOnly: true }), /does not have access/);
});
