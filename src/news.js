// The news bar: one line, full width, sitting between the height strip and the map.
//
// It is the only thing on this page that says something a human wrote rather than
// something a phone measured, which is why it gets its own module and its own rules.
// Everything else on screen is a reading; this is a message.
//
// Two decisions shape the whole file:
//
//   1. It is EXACTLY one line tall. A bar that can wrap is a bar that reflows the
//      map under it whenever somebody edits a sentence, and the map is what people
//      came for. A message too long for the width scrolls instead — which is the
//      other half of the design, and the reason for `marqueeState`.
//
//   2. It renders a deliberately tiny subset of Markdown, by hand. There is no
//      build step and no dependency in this repo, and a Markdown library is a large
//      thing to take on for four constructs — but a bare URL in a banner nobody can
//      click is a link that isn't one. See `renderNews` for what is and isn't
//      supported, and why the order of the substitutions is not negotiable.

import { CONFIG } from './config.js';
import { escapeHtml } from './util.js';

/**
 * A banner's text, as HTML safe to assign.
 *
 * The supported subset, and nothing else:
 *
 *   [text](https://…)   a link, opened in a new tab
 *   **bold**  *italic*  `code`
 *
 * Anything unmatched stays as literal text. There is no "best effort" fallthrough:
 * an unclosed `**` is two asterisks, because a parser that guesses at what somebody
 * meant is a parser that renders half a sentence in bold on a race day.
 *
 * The ORDER below is load-bearing at every step:
 *
 *   1. Escape FIRST, so the input is inert before anything starts building markup
 *      out of it. Every later rule emits tags around text that can no longer contain
 *      any. This is the whole security argument, and it only works this way round —
 *      escaping afterwards would escape the tags we had just written.
 *
 *   2. PARK finished markup behind a placeholder rather than leaving it in the
 *      string. Two different bugs need this, and only this fixes both:
 *      `` `a*b*c` `` must not come back with an `<em>` inside the `<code>`, and an
 *      `href` — where `*` is a perfectly legal path character — must not have one
 *      pushed into the middle of it, which corrupts the URL rather than merely
 *      styling it oddly.
 *
 *   3. `**bold**` before `*italic*`. The other way round, `**x**` parses as two
 *      empty `<em>`s wrapped around an x.
 *
 * The URL is tested AFTER escaping, which is deliberate and has one consequence worth
 * stating: a query string's `&` arrives here as `&amp;`, and it MATCHES. That is the
 * correct thing to have inside an `href` — the browser unescapes it on the way out —
 * so it is not a reason to reject the link. Only `http:` and `https:` pass;
 * `javascript:`, `data:` and everything else fall through to literal text, visibly
 * un-linked, which is the honest way to refuse.
 *
 * @param {string} text the raw `news_banner` string.
 * @returns {string} HTML.
 */
export function renderNews(text) {
  const done = [];
  // NUL-delimited, and safe as a delimiter precisely because NUL is stripped from the
  // input on the line below: an author cannot write one that survives to collide.
  const park = html => `\u0000${done.push(html) - 1}\u0000`;

  const out = escapeHtml(String(text ?? '').replace(/\u0000/g, ''))
    .replace(/`([^`]+)`/g, (_, code) => park(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
      park(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => done[Number(i)]);
}

/**
 * Whether the message has to scroll, and how long one lap should take.
 *
 * Pure and exported so the one piece of arithmetic in this file can be tested
 * without a layout engine — the rest of the module is measurement and class names.
 *
 * The duration is derived from the CONTENT's width rather than from the overflow,
 * so the text crosses the screen at the same speed whatever it says. Scrolling every
 * message in a fixed number of seconds instead would make a long one a blur and a
 * short one a crawl, which is the failure mode of every marquee ever written.
 *
 * `reduced` is not "animate less". A banner that overflows and cannot move has been
 * silently truncated, and the reader has no way to reach the rest of it — so honouring
 * the preference means turning the animation OFF and letting the bar scroll by hand
 * instead, which the caller arranges. Either way `marquee` is false and there is no
 * third state to reason about.
 *
 * @param {number}  contentPx one copy of the message, including its trailing gap.
 * @param {number}  boxPx     the bar's own width.
 * @param {boolean} reduced   `prefers-reduced-motion` is set.
 */
export function marqueeState({ contentPx, boxPx, reduced = false }) {
  // Zero width is a bar that hasn't been laid out yet — measuring it would produce a
  // duration of zero and a strobing element. Not scrolling is the right answer until
  // there is something to measure; `sync` runs again on the next resize or font load.
  const marquee = !reduced && contentPx > 0 && boxPx > 0 && contentPx > boxPx;
  return {
    marquee,
    durationMs: marquee ? Math.round((contentPx / CONFIG.newsSpeedPxPerSec) * 1000) : 0
  };
}

/**
 * The bar itself.
 *
 * Mirrors [`createProfile`](./profile.js)'s `sync`: one function owns the custom
 * property saying how much of the bottom of the window this is covering, and
 * everything anchored down there reads it rather than keeping its own copy.
 *
 * @param {HTMLElement} root the `#news` element.
 */
export function createNews(root) {
  // Two copies of the message, which is what makes the loop seamless. The track is
  // translated by exactly -50% of its own width, and half of a two-copy track is one
  // copy — so the moment the animation restarts, copy 1 is sitting precisely where
  // copy 2 was, and the join is invisible without a single measured pixel.
  //
  // The second copy is `aria-hidden`, so a screen reader is not read the message
  // twice. There is no `aria-live` here at all: this re-renders on every resize, and
  // a live region would announce itself again each time the window changed size.
  const copies = [...root.querySelectorAll('.news-copy')];
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');

  let text = '';

  function sync() {
    const on = Boolean(text);
    root.hidden = !on;
    // Set even when hidden, and to an explicit `0px` rather than being removed:
    // `bottomInset` and the profile's tooltip both add this in, and a missing custom
    // property makes the whole `calc()` invalid rather than making it zero.
    document.documentElement.style.setProperty('--news-h', on ? `${CONFIG.newsHeight}px` : '0px');
    if (!on) return;

    // The gap belongs to the CSS, but its VALUE has to be the one the measurement
    // below sees — `scrollWidth` includes it, and the -50% translate assumes the two
    // agree. One number, set from config, read by both.
    root.style.setProperty('--news-gap', `${CONFIG.newsGapPx}px`);

    const state = marqueeState({
      // One copy's own width, gap included — it is carried as that copy's margin, so
      // the measurement and the -50% translate are describing the same box.
      contentPx: copies[0].scrollWidth,
      boxPx: root.clientWidth,
      reduced: reduceQuery.matches
    });

    root.dataset.marquee = String(state.marquee);
    root.style.setProperty('--news-dur', `${state.durationMs}ms`);
    syncFades();
  }

  /**
   * The same edge treatment the height strip uses, for the same reason: something has
   * to say the text continues past the edge. Only reachable when the bar scrolls by
   * hand — under `prefers-reduced-motion` — since an animated track never overflows
   * its own scroller.
   */
  function syncFades() {
    const more = root.scrollWidth - root.clientWidth - root.scrollLeft;
    root.dataset.moreLeft = String(root.scrollLeft > 1);
    root.dataset.moreRight = String(more > 1);
  }

  root.addEventListener('scroll', syncFades);
  addEventListener('resize', sync);
  reduceQuery.addEventListener('change', sync);
  // A webfont landing changes every measurement on the page, and it lands after this
  // module has already run. Without this, a banner that just fits at fallback metrics
  // and just doesn't at the real ones would never start scrolling.
  document.fonts?.ready.then(sync);

  return {
    /**
     * @param {string} next the run's `news_banner`, or '' for none.
     *
     * Idempotent, and that is not tidiness — this is called on every paint, and
     * re-rendering identical markup would restart the animation from the left edge
     * several times a minute, so a long message would never once reach its end.
     */
    setBanner(next = '') {
      const wanted = next || '';
      if (wanted === text) return;
      text = wanted;
      if (text) {
        const html = renderNews(text);
        for (const copy of copies) copy.innerHTML = html;
      }
      sync();
    }
  };
}
