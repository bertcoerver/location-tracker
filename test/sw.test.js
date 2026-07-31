import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// sw.js is a worker script: it calls `self.addEventListener` at the top level and
// cannot be imported here. Everything below reads it as text, which is enough —
// what these guard is the precache list, and the list is a literal.
const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(`${root}sw.js`, 'utf8');

/** The `SHELL_URLS` array, read out of the source. */
function shellUrls() {
  const body = source.match(/const SHELL_URLS = \[([\s\S]*?)\];/);
  assert.ok(body, 'SHELL_URLS is not where this test expects it');
  return [...body[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

test('every module in src/ is precached', () => {
  const onDisk = readdirSync(`${root}src`).filter(f => f.endsWith('.js')).sort();
  const cached = shellUrls()
    .filter(u => u.startsWith('./src/'))
    .map(u => u.slice('./src/'.length))
    .sort();

  // The failure this exists for: adding a module and forgetting the worker, which
  // ships an app that goes to the network for one file and so does not open at all
  // without one.
  assert.deepEqual(cached, onDisk);
});

test('every icon the manifest names is precached', () => {
  const manifest = JSON.parse(readFileSync(`${root}manifest.webmanifest`, 'utf8'));
  const cached = new Set(shellUrls());
  for (const icon of manifest.icons) {
    assert.ok(cached.has(`./${icon.src}`), `${icon.src} is not in SHELL_URLS`);
  }
});

test('everything precached actually exists', () => {
  for (const url of shellUrls()) {
    if (url === './') continue;
    const path = `${root}${url.slice(2)}`;
    // `addAll` is atomic, so one missing file does not degrade the install — it
    // fails it, and the app never caches anything at all.
    assert.doesNotThrow(() => readFileSync(path), `${url} is missing`);
  }
});

test('the vendored deck.gl is the one index.html loads', () => {
  const html = readFileSync(`${root}index.html`, 'utf8');
  const tag = html.match(/<script src="(vendor\/[^"]+)"/);
  assert.ok(tag, 'index.html does not load deck.gl from vendor/');
  assert.ok(
    shellUrls().includes(`./${tag[1]}`),
    'the vendored deck.gl is not precached'
  );
});

test('only the shell cache is keyed to the version', () => {
  // A deploy bumps VERSION, and `activate` deletes every cache not on KEEP. If the
  // data or tile cache were named with it, shipping a CSS tweak would drop every
  // ping and every tile of a race already in progress — throwing away the offline
  // cache at exactly the moment it is being relied on.
  const names = [...source.matchAll(/^const (SHELL|DATA|TILES) = (.+);$/gm)]
    .reduce((acc, [, k, v]) => ({ ...acc, [k]: v }), {});

  assert.match(names.SHELL, /VERSION/);
  assert.doesNotMatch(names.DATA, /VERSION/);
  assert.doesNotMatch(names.TILES, /VERSION/);
});

test('sha-addressed blobs go to the data cache, not the shell', () => {
  const fn = source.match(/async function immutable\(req\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, 'immutable() is not where this test expects it');
  assert.match(fn[1], /caches\.open\(DATA\)/);
});

test('the GitHub API is never served from a cache', () => {
  // The listing is the only thing that says a new ping exists. If this ever gets
  // a cache strategy, the map silently stops updating — the worst failure this
  // app has, because it looks exactly like a runner who has stopped.
  const api = source.indexOf("url.hostname === 'api.github.com'");
  assert.ok(api > 0, 'the api.github.com route is gone');
  const clause = source.slice(api, api + 120);
  assert.match(clause, /return;/, 'api.github.com no longer falls through to the network');
});
