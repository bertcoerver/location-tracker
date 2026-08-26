// The news bar's two pure halves. The bar itself is DOM, and DOM is not what these
// tests are for — what IS worth testing is the hand-rolled Markdown, where the order
// of the substitutions is the whole design and every bug in it is silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { marqueeState, renderNews } from '../src/news.js';

// --- the markdown subset -----------------------------------------------------

test('plain text comes back as plain text', () => {
  assert.equal(renderNews('Race is on'), 'Race is on');
  // Emoji and accents need nothing done to them at all. UTF-8 all the way down.
  assert.equal(renderNews('Île de Ré 👟'), 'Île de Ré 👟');
});

test('the four supported constructs render', () => {
  assert.equal(renderNews('**go**'), '<strong>go</strong>');
  assert.equal(renderNews('*go*'), '<em>go</em>');
  assert.equal(renderNews('`go`'), '<code>go</code>');
  assert.equal(
    renderNews('[here](https://some.url)'),
    '<a href="https://some.url" target="_blank" rel="noopener noreferrer">here</a>'
  );
});

test('bold is matched before italic', () => {
  // The other way round, `**x**` parses as two empty <em>s wrapped around an x.
  assert.equal(renderNews('**x**'), '<strong>x</strong>');
  assert.equal(renderNews('**a** and *b*'), '<strong>a</strong> and <em>b</em>');
});

test('a code span is not emphasised from the inside', () => {
  // The classic ordering bug, and exactly what somebody pasting a filename hits.
  assert.equal(renderNews('`a*b*c`'), '<code>a*b*c</code>');
  assert.equal(renderNews('`**x**`'), '<code>**x**</code>');
});

test('an asterisk in a URL stays in the URL', () => {
  // Sharper than the code case: an emphasis rule reaching into a finished href does
  // not style it oddly, it CORRUPTS it — the link then points somewhere else.
  const html = renderNews('[x](https://a.test/*p*/q)');
  assert.match(html, /href="https:\/\/a\.test\/\*p\*\/q"/);
  assert.equal(html.includes('<em>'), false);
});

test('an escaped ampersand in a query string is still a link', () => {
  // The URL is tested after escaping, so `&` arrives as `&amp;` — which is the
  // correct thing to have inside an href, not a reason to refuse the link.
  const html = renderNews('[x](https://a.test/?a=1&b=2)');
  assert.match(html, /href="https:\/\/a\.test\/\?a=1&amp;b=2"/);
});

// --- what it refuses ---------------------------------------------------------

test('markup in the message is text, not markup', () => {
  assert.equal(renderNews('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(renderNews('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
});

test('only http and https are ever linked', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/local']) {
    const html = renderNews(`[click](${url})`);
    assert.equal(html.includes('<a '), false, `${url} must not become a link`);
    assert.equal(html.includes('href'), false, `${url} must not reach an attribute`);
  }
});

test('a quote in a link label cannot break out of the tag', () => {
  const html = renderNews('[a" onmouseover="x](https://a.test)');
  assert.equal(html.includes('onmouseover="x"'), false);
  assert.match(html, /&quot;/);
});

test('an unclosed construct is two asterisks, not a guess', () => {
  // A parser that guesses at what somebody meant renders half a sentence in bold on
  // a race day. There is no best-effort fallthrough here.
  assert.equal(renderNews('**oops'), '**oops');
  assert.equal(renderNews('`oops'), '`oops');
  assert.equal(renderNews('[oops](https://a.test'), '[oops](https://a.test');
});

test('a NUL in the message cannot collide with the placeholder', () => {
  // The parking scheme is NUL-delimited, which is only safe because NUL is stripped
  // from the input first. If it were not, a message could name a slot it does not own.
  const nul = String.fromCharCode(0);
  assert.equal(renderNews(`a${nul}0${nul}b \`c\``), 'a0b <code>c</code>');
});

test('nothing at all is an empty string, not a crash', () => {
  assert.equal(renderNews(''), '');
  assert.equal(renderNews(null), '');
  assert.equal(renderNews(undefined), '');
});

// --- when it has to scroll ---------------------------------------------------

test('a message that fits does not move', () => {
  const state = marqueeState({ contentPx: 200, boxPx: 600 });
  assert.equal(state.marquee, false);
  assert.equal(state.durationMs, 0);
});

test('a message too wide scrolls, at a speed rather than in a fixed time', () => {
  // The duration comes from the CONTENT's width, so the text crosses the screen at
  // one speed whatever it says. A fixed duration would blur a long message and make
  // a short one crawl — the failure mode of every marquee ever written.
  const short = marqueeState({ contentPx: 900, boxPx: 600 });
  const long = marqueeState({ contentPx: 1800, boxPx: 600 });

  assert.equal(short.marquee, true);
  assert.equal(long.durationMs, short.durationMs * 2, 'twice the text, twice the lap');
  assert.equal(short.durationMs, Math.round((900 / CONFIG.newsSpeedPxPerSec) * 1000));
});

test('the gap is part of the lap, not part of the decision', () => {
  // One lap moves the track by a copy PLUS its gap, so timing the copy alone runs the
  // text fast by the ratio between them.
  const state = marqueeState({ contentPx: 900, gapPx: 96, boxPx: 600 });
  assert.equal(state.durationMs, Math.round((996 / CONFIG.newsSpeedPxPerSec) * 1000));

  // But a message that fits the bar on its own fits. Counting the gap here would set a
  // bar of clear space scrolling to make room for a gap that only exists because it
  // scrolls — and it would never stop, since scrolling is what creates the gap.
  assert.equal(marqueeState({ contentPx: 550, gapPx: 96, boxPx: 600 }).marquee, false);
});

test('reduced motion never scrolls, however long the message', () => {
  // Not "animate less": the bar becomes scrollable by hand instead, which the CSS
  // arranges off this same false. Truncating with no way to reach the rest would be
  // the one outcome worse than either.
  const state = marqueeState({ contentPx: 5000, boxPx: 300, reduced: true });
  assert.equal(state.marquee, false);
  assert.equal(state.durationMs, 0);
});

test('an unmeasured bar does not scroll', () => {
  // Before first layout both numbers are 0. Scrolling then would mean a duration of
  // zero and a strobing element; `sync` runs again on the next resize or font load.
  assert.equal(marqueeState({ contentPx: 0, boxPx: 0 }).marquee, false);
  assert.equal(marqueeState({ contentPx: 400, boxPx: 0 }).marquee, false);
});
