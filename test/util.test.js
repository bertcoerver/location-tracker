import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ago, escapeHtml, parseTime, pool } from '../src/util.js';

test('parseTime recovers the ISO timestamp from a filename', () => {
  // Underscores stand in for colons — in the time AND in the UTC offset.
  assert.equal(
    parseTime('2026-07-28T12_06_01+02_00.json'),
    Date.parse('2026-07-28T12:06:01+02:00')
  );
});

test('parseTime works with or without the .json extension', () => {
  assert.equal(
    parseTime('2026-07-28T12_06_01+02_00'),
    parseTime('2026-07-28T12_06_01+02_00.json')
  );
});

test('parseTime honours the offset rather than assuming UTC', () => {
  const plus2 = parseTime('2026-07-28T12_00_00+02_00.json');
  const utc   = parseTime('2026-07-28T12_00_00+00_00.json');
  assert.equal(utc - plus2, 2 * 3600 * 1000);
});

test('parseTime returns NaN for a name it cannot read', () => {
  assert.ok(Number.isNaN(parseTime('README.json')));
});

test('ago formats each magnitude', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  assert.equal(ago(now - 30 * 1000, now), '30s ago');
  assert.equal(ago(now - 5 * 60000, now), '5m ago');
  assert.equal(ago(now - 3 * 3600000, now), '3h ago');
  assert.equal(ago(now - 2 * 86400000, now), '2d ago');
});

test('ago never reports a negative age for a clock-skewed future point', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  assert.equal(ago(now + 60000, now), '0s ago');
});

test('pool visits every item and respects the concurrency limit', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;

  const results = await pool(items, 4, async i => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
    return i * 2;
  });

  assert.equal(results.length, 20);
  assert.deepEqual(results.sort((a, b) => a - b), items.map(i => i * 2));
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('pool handles an empty list without hanging', async () => {
  assert.deepEqual(await pool([], 8, async () => 1), []);
});

test('escapeHtml neutralises markup from user-supplied messages', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
});
