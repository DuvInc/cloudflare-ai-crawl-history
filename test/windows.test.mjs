import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounds, dueWindows, horizonHours, FALLBACK_HORIZON_HOURS } from '../lib/windows.mjs';

test('windows are aligned to UTC midnight and keyed by their start', () => {
  const now = new Date('2026-10-10T09:07:00Z');
  assert.deepEqual(dueWindows({ now, horizon: 12 }), ['2026-10-10T00', '2026-10-10T04']);
  assert.deepEqual(dueWindows({ now, horizon: 14 }), ['2026-10-09T20', '2026-10-10T00', '2026-10-10T04']);
});

test('the window in progress is never due', () => {
  const due = dueWindows({ now: new Date('2026-10-10T07:59:00Z'), horizon: 8 });
  assert.ok(!due.includes('2026-10-10T04'));
  assert.ok(due.includes('2026-10-10T00'));
});

test('nothing before `since`, so imported history is not counted twice', () => {
  const due = dueWindows({ now: new Date('2026-10-10T09:07:00Z'), horizon: 20, since: '2026-10-10T00' });
  assert.deepEqual(due, ['2026-10-10T00', '2026-10-10T04']);
});

test('bounds: the end is the next window start, because datetime_lt is exclusive', () => {
  const { since, until } = bounds('2026-10-10T20');
  assert.equal(since.toISOString(), '2026-10-10T20:00:00.000Z');
  assert.equal(until.toISOString(), '2026-10-11T00:00:00.000Z');
  assert.throws(() => bounds('yesterday'));
});

test('horizon comes from the API, minus a margin, capped', () => {
  assert.equal(horizonHours(86_400), 20);
  assert.equal(horizonHours(31 * 86_400), 7 * 24);
  assert.equal(horizonHours(31 * 86_400, { maxHours: 48 }), 48);
});

test('horizon falls back to 20 hours when the API says nothing', () => {
  assert.equal(horizonHours(null), FALLBACK_HORIZON_HOURS);
  assert.equal(horizonHours(undefined), FALLBACK_HORIZON_HOURS);
  assert.equal(horizonHours(0), FALLBACK_HORIZON_HOURS);
});
