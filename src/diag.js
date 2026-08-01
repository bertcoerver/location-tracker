// A viewport readout for the app itself, behind `?diag=1`.
//
// diag.html measures the same numbers, but it is a different document with a
// different manifest, and two rounds of chasing a white band along the bottom of
// the screen were spent discovering that a proxy is not the thing. This one runs
// inside the real app, on the real shell, with the real service worker.
//
// Throwaway. Delete this file, its line in main.js and its entry in sw.js once the
// safe-area question is closed.

/**
 * Arm the toggle, and draw the overlay if it has been asked for. An ordinary load
 * gets one event listener on the status panel and nothing else.
 */
export function maybeShowDiag() {
  // Three taps on the status panel toggle it, and that is the ONLY way that works
  // on an installed iOS app. A home-screen web app has its own storage container,
  // separate from Safari's, so a flag set in Safari is invisible here — and the
  // manifest's `start_url` is `.`, so a home-screen launch drops any query string
  // before the page ever sees it. A gesture is the one channel into the installed
  // app that neither of those can cut.
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
      document.getElementById('diag')?.remove();
      document.getElementById('diag-edge')?.remove();
    } else {
      localStorage.setItem('diag', '1');
      render();
    }
  });

  // `?diag=1` still works, for Safari and for the desktop.
  const asked = new URLSearchParams(location.search).get('diag');
  if (asked === '1') localStorage.setItem('diag', '1');
  if (asked === '0') localStorage.removeItem('diag');
  if (localStorage.getItem('diag') === '1') render();
}

function render() {
  document.getElementById('diag')?.remove();
  document.getElementById('diag-edge')?.remove();

  // Per app launch on iOS, so a cold start reads 1 and anything after a reload
  // reads higher. The whole question is whether the viewport changes shape between
  // the first paint of a launch and every one after it.
  const loads = Number(sessionStorage.getItem('diagLoads') || 0) + 1;
  sessionStorage.setItem('diagLoads', String(loads));

  // env() is not readable off a custom property, so put it on a real element and
  // ask what came out.
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding:env(safe-area-inset-top)' +
    ' env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const inset = getComputedStyle(probe);

  const mode = ['standalone', 'fullscreen', 'minimal-ui', 'browser']
    .find(m => matchMedia(`(display-mode: ${m})`).matches) || 'unknown';
  const dead = screen.height - innerHeight;

  const rows = [
    ['load # this launch', loads === 1 ? '1 (fresh launch)' : `${loads} (after reload)`],
    ['display-mode', mode],
    ['safe-area top', inset.paddingTop],
    ['safe-area bottom', inset.paddingBottom],
    ['innerHeight', innerHeight],
    ['screen.height', screen.height],
    ['DEAD SPACE', `${dead}px`],
    ['--profile-h', getComputedStyle(document.documentElement)
      .getPropertyValue('--profile-h').trim() || '(unset)'],
    ['#profile bottom', profileBottom()],
    ['', 'TAP HERE TO NUDGE'],
  ];

  const box = document.createElement('div');
  box.id = 'diag';
  box.style.cssText =
    'position:fixed;left:8px;top:calc(env(safe-area-inset-top) + 8px);z-index:99;' +
    'background:rgba(0,0,0,.86);color:#fff;font:11px/1.5 ui-monospace,Menlo,monospace;' +
    'padding:8px 10px;border-radius:8px;max-width:calc(100vw - 16px)';
  box.innerHTML = rows
    .map(([k, v]) => (k
      ? `<div>${k}: <b style="color:${
          k === 'DEAD SPACE' && parseFloat(v) > 0 ? '#ff7a5c' : '#8fe3a0'}">${v}</b></div>`
      : `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #555;
           text-align:center;color:#7ab8ff">${v}</div>`))
    .join('');
  // The candidate runtime fix, on the overlay itself so one screenshot can answer
  // whether it works. Rewriting the viewport meta forces iOS to evaluate it again;
  // if DEAD SPACE falls to 0 and the orange bar reaches the bottom of the screen,
  // this repairs the damage whatever is causing it.
  box.addEventListener('click', () => {
    const vp = document.querySelector('meta[name="viewport"]');
    const base = vp.getAttribute('content');
    vp.setAttribute('content', base.replace('viewport-fit=cover', 'viewport-fit=contain'));
    requestAnimationFrame(() => {
      vp.setAttribute('content', base);
      // Two frames plus a beat: one for the meta to take, one for the layout it
      // causes, and the timeout because iOS resizes the viewport asynchronously.
      requestAnimationFrame(() => setTimeout(render, 250));
    });
  });
  document.body.append(box);

  // The same proof diag.html uses: a bar pinned to the bottom of the LAYOUT
  // viewport. Any screen visible below it is outside the viewport, and nothing in
  // this stylesheet can reach it.
  const edge = document.createElement('div');
  edge.id = 'diag-edge';
  edge.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;height:4px;background:#eb6834;z-index:99';
  document.body.append(edge);
}

/** Where the height strip's bottom edge actually landed, or why there isn't one. */
function profileBottom() {
  const el = document.getElementById('profile');
  if (!el || el.hidden) return '(hidden)';
  const r = el.getBoundingClientRect();
  return `${Math.round(r.bottom)} of ${innerHeight}`;
}
