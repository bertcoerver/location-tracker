// THROWAWAY. A viewport readout and a head-variant switch, for one open question:
// whether the edge-to-edge top (`viewport-fit=cover`) can be had without the band
// of dead screen along the bottom that it caused on iOS 18.7.
//
// iOS fixes the viewport at launch. A query string never arrives — the manifest's
// `start_url` is `.` — and rewriting the meta afterwards does nothing. So the
// variant has to be in place before the body is parsed, which is what the inline
// script in index.html does with the number this file writes.
//
// Delete this file, that script, the line in main.js and the entry in sw.js once
// the question is settled.

// Base is what ships. 1-3 are the three ways of asking for the top back.
const VARIANTS = [
  '0 NO cover — ships, clean bottom',
  '1 cover + translucent — had the band',
  '2 cover, NO status-bar style',
  '3 cover + opaque status bar',
];

/**
 * Arm the toggle, and draw the overlay if it has been asked for. An ordinary load
 * gets one event listener on the status panel and nothing else.
 */
export function maybeShowDiag() {
  // Three taps on the status panel. The only channel that works on an installed
  // iOS app: it has its own storage container, so a flag set in Safari is invisible
  // here, and a home-screen launch drops any query string before the page sees it.
  let taps = 0;
  let last = 0;
  document.getElementById('status')?.addEventListener('pointerup', () => {
    const now = Date.now();
    taps = now - last > 800 ? 1 : taps + 1;
    last = now;
    if (taps < 3) return;
    taps = 0;
    if (localStorage.getItem('diag') === '1') {
      localStorage.removeItem('diag');
      remove();
    } else {
      localStorage.setItem('diag', '1');
      render();
    }
  });

  const asked = new URLSearchParams(location.search).get('diag');
  if (asked === '1') localStorage.setItem('diag', '1');
  if (asked === '0') localStorage.removeItem('diag');
  if (localStorage.getItem('diag') === '1') render();
}

function remove() {
  document.getElementById('diag')?.remove();
  document.getElementById('diag-edge')?.remove();
}

function render() {
  remove();

  const variant = Number(localStorage.getItem('vpVariant') || 0);

  // env() is not readable off a custom property, so put it on a real element and
  // ask what came out.
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding:env(safe-area-inset-top)' +
    ' env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const inset = getComputedStyle(probe);
  probe.remove();

  const rows = [
    ['VARIANT', VARIANTS[variant] || variant],
    ['safe-area top', inset.paddingTop],
    ['safe-area bottom', inset.paddingBottom],
    ['innerHeight', innerHeight],
    ['screen.height', screen.height],
    // In cover mode this is the band along the BOTTOM, which is the bug. Without
    // cover it is the status bar at the top, which is normal — so read it together
    // with where the orange bar lands, not on its own.
    ['screen - inner', `${screen.height - innerHeight}px`],
  ];

  const box = document.createElement('div');
  box.id = 'diag';
  box.style.cssText =
    'position:fixed;left:8px;top:calc(env(safe-area-inset-top) + 8px);z-index:99;' +
    'background:rgba(0,0,0,.86);color:#fff;font:11px/1.5 ui-monospace,Menlo,monospace;' +
    'padding:8px 10px;border-radius:8px;max-width:calc(100vw - 16px)';
  box.innerHTML = rows
    .map(([k, v]) => `<div>${k}: <b style="color:#8fe3a0">${v}</b></div>`)
    .join('') +
    '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #555;' +
    'text-align:center;color:#7ab8ff">TAP: NEXT VARIANT, THEN FORCE-QUIT</div>';

  // Advancing cannot take effect now — the viewport is already fixed for this
  // launch — so this only writes the number and redraws the label.
  box.addEventListener('click', () => {
    localStorage.setItem('vpVariant', String((variant + 1) % VARIANTS.length));
    render();
  });
  document.body.append(box);

  // Pinned to the bottom of the LAYOUT viewport. Any screen visible below it is
  // outside the viewport, and nothing in the stylesheet can reach it. This is the
  // reading that matters, not the number above.
  const edge = document.createElement('div');
  edge.id = 'diag-edge';
  edge.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;height:4px;background:#eb6834;z-index:99';
  document.body.append(edge);
}
