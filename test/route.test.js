import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRun, urlFor } from '../src/route.js';

test('no run parameter means "pick the newest run"', () => {
  assert.equal(parseRun(''), null);
  assert.equal(parseRun('?follow=1'), null);
  assert.equal(parseRun('?run='), null);
});

test('a plain run name is taken as-is', () => {
  assert.equal(parseRun('?run=vendee-10k'), 'vendee-10k');
  assert.equal(parseRun('?run=marathon_2026&x=1'), 'marathon_2026');
});

test('the full repo path form is accepted too', () => {
  // This is the shape you'd copy out of a GitHub URL.
  assert.equal(parseRun('?run=locations/vendee-10k'), 'vendee-10k');
  assert.equal(parseRun('?run=/locations/vendee-10k/'), 'vendee-10k');
});

test('traversal and other unusable names unpin, never reach a path', () => {
  // The names below must not survive into a fetch URL under any cleaning.
  for (const bad of ['..', '../../etc', 'a/b', 'a b', '.hidden', '%2e%2e', '']) {
    assert.equal(parseRun(`?run=${encodeURIComponent(bad)}`), null, bad);
  }
});

test('urlFor round-trips through parseRun', () => {
  for (const run of ['vendee-10k', 'marathon_2026', 'test']) {
    assert.equal(parseRun(urlFor(run)), run);
  }
  assert.equal(urlFor(null), '.');
});
