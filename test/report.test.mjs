import { test } from 'node:test';
import assert from 'node:assert/strict';
import { health, isAi, sum, urlParts } from '../lib/report.mjs';

const ok = (zone, hour) => ({ zone, hour, span_hours: 4, status: 'ok' });

/* A four day old archive once reported 86 missing days. */
test('health counts from the first window, not from the start of the range', () => {
  const ledger = ['2026-10-10T00', '2026-10-10T04'].map((h) => ok('example.com', h));
  const h = health(ledger, { now: new Date('2026-10-10T08:20:00Z'), days: 90 });
  assert.equal(h.sites[0].hours, '8/8');
  assert.equal(h.sites[0].missing, 0);
  assert.equal(h.healthy, true);
});

test('a hole is a hole, a partial window is not', () => {
  const ledger = [
    ok('example.com', '2026-10-10T00'),
    { zone: 'example.com', hour: '2026-10-10T04', span_hours: 4, status: 'partial' },
    ok('example.org', '2026-10-10T00'),
    { zone: 'example.org', hour: '2026-10-10T04', span_hours: 4, status: 'failed' },
  ];
  const h = health(ledger, { now: new Date('2026-10-10T08:20:00Z') });
  const [com, org] = h.sites;
  assert.deepEqual([com.missing, com.partial_hours], [0, 4]);
  assert.deepEqual([org.missing, org.partial_hours], [4, 0]);
  assert.equal(h.healthy, false);
});

test('the window the cron has not reached yet is not counted as missing', () => {
  const h = health([ok('example.com', '2026-10-10T00')], { now: new Date('2026-10-10T08:03:00Z') });
  assert.equal(h.sites[0].hours, '4/4');
});

test('a run-level failure makes the archive unhealthy', () => {
  const h = health([ok('example.com', '2026-10-10T00'), { zone: '*', hour: '2026-10-10T04', status: 'failed' }],
    { now: new Date('2026-10-10T04:20:00Z') });
  assert.equal(h.healthy, false);
});

/* COUNT(*) once disagreed with a total reported minutes earlier. */
test('sum adds requests, it does not count rows', () => {
  const rows = [
    { bot_name: 'GPTBot', path: '/a', requests: 10 },
    { bot_name: 'GPTBot', path: '/b', requests: 5 },
    { bot_name: 'ClaudeBot', path: '/a', requests: 1 },
  ];
  assert.deepEqual(sum(rows, ['bot_name'], { distinct: 'path' }), [
    { bot_name: 'GPTBot', requests: 15, distinct_path: 2 },
    { bot_name: 'ClaudeBot', requests: 1, distinct_path: 1 },
  ]);
});

test('isAi matches Cloudflare AI categories only', () => {
  assert.ok(isAi({ bot_category: 'AI Crawler' }));
  assert.ok(isAi({ bot_category: 'AI Assistant' }));
  assert.ok(!isAi({ bot_category: 'Search Engine Crawler' }));
  assert.ok(!isAi({ bot_category: 'Email' }));
});

test('urlParts: only listed locales are locales', () => {
  assert.deepEqual(urlParts('/fr/docs/setup', { locales: ['fr'] }), { locale: 'fr', section: 'docs' });
  assert.deepEqual(urlParts('/docs/setup', { locales: ['fr'] }), { locale: '', section: 'docs' });
  assert.deepEqual(urlParts('/fa/x', { locales: ['fr'] }), { locale: '', section: 'fa' });
  assert.deepEqual(urlParts('/blog/post.md'), { locale: '', section: 'blog' });
  assert.deepEqual(urlParts('/index.md'), { locale: '', section: '' });
  assert.deepEqual(urlParts('/docs/fr/x', { locales: ['fr'], prefix: '/docs' }), { locale: 'fr', section: 'x' });
});
