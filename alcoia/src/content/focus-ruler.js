/* focus-ruler.js
   A horizontal band of clear page with everything above and below dimmed,
   keeping the eye anchored to the line being read. Helpful for dyslexic
   readers and anyone who loses their place in long paragraphs.

   ── Where the band gets its position ────────────────────────────────────
   It used to follow gaze Y and nothing else, which meant that with the
   camera off — now the default — `update()` was never called and the band
   sat wherever it was last left. The ruler was a camera feature wearing a
   reading feature's name.

   It now takes its position from the best source currently available:

     1. gaze    — only while a sample has arrived in the last 2s
     2. cursor  — only while the pointer has moved in the last 4s AND is
                  inside body text; people park the mouse anywhere, and a
                  stale cursor is not a reading position
     3. the reading line — a fixed fraction of viewport height, the same
                  anchor telemetry/paragraph-tracker.js uses to decide which
                  paragraph is being read

   Source 3 is always available, needs no permission, and is the correct
   behaviour on touch devices, which have no cursor and no usable camera.
   That makes it the floor rather than the failure case.
*/

import { readingAxis } from './telemetry/segmentation.js';

const RULER_ID    = 'sra-focus-ruler';
const DIM_OPACITY = 0.38;
const SMOOTH_K    = 0.14;

/* Matches paragraph-tracker.js. Change both or neither: the band would
   otherwise highlight a different line from the one being timed. */
const READING_LINE_FRACTION = 0.4;

const GAZE_FRESH_MS   = 2000;
const CURSOR_FRESH_MS = 4000;
const TICK_MS         = 400;   // re-resolve the source when nothing moves

/* Half-height of the clear window per state. Full band is twice this. */
const BAND_BY_STATE = {
  on_pace:    52,   // 104 px — comfortable reading
  skimming:   80,   // 160 px — moving fast, wide window
  struggling: 34,   //  68 px — tighten; the line is the problem
  drifting:   64,   // 128 px — gentle re-engagement
  absent:     52,
  unknown:    52,
};
const DEFAULT_BAND_PX = 52;

export function createFocusRuler() {
  let enabled    = false;
  let smoothY    = null;
  let rafPending = false;
  let pendingY   = null;
  let bandPx     = DEFAULT_BAND_PX;

  let gazeY = null, gazeAt = 0;
  let curY  = null, curAt  = 0;
  let ticker = null;

  let axisCache = { at: 0, vertical: false, rtl: false };
  function getAxis() {
    const t = Date.now();
    if (t - axisCache.at > 2000) axisCache = { at: t, ...readingAxis(document) };
    return axisCache;
  }
  const getVertical = () => getAxis().vertical;

  /* In vertical writing the reading position is an x coordinate, and vertical-rl
     starts at the right edge. */
  const readingLineY = () => {
    const a = getAxis();
    if (!a.vertical) return window.innerHeight * READING_LINE_FRACTION;
    const f = a.rtl ? 1 - READING_LINE_FRACTION : READING_LINE_FRACTION;
    return window.innerWidth * f;
  };

  /* True when the pointer is over something that looks like body text. A
     cursor parked on a nav bar is not a reading position. */
  function cursorIsOnText(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    if (el.closest('#' + RULER_ID)) return false;
    if (el.closest('.sra-popup, .sra-receipt, #sra-reading-map')) return false;
    return !!el.closest('p, li, blockquote, article, section, main, td, dd');
  }

  function resolveY() {
    const now = Date.now();
    if (gazeY !== null && now - gazeAt < GAZE_FRESH_MS)   return gazeY;
    if (curY  !== null && now - curAt  < CURSOR_FRESH_MS) return curY;
    return readingLineY();
  }

  function ensureDOM() {
    if (document.getElementById(RULER_ID)) return;

    const ruler = document.createElement('div');
    ruler.id = RULER_ID;
    Object.assign(ruler.style, {
      position: 'fixed', inset: '0',
      pointerEvents: 'none', zIndex: '2147483638', display: 'none',
    });

    const mk = (id, edge) => {
      const d = document.createElement('div');
      d.id = id;
      Object.assign(d.style, {
        position: 'absolute', left: '0', right: '0', [edge]: '0',
        background: 'rgba(0,0,0,' + DIM_OPACITY + ')',
        transition: 'height 90ms linear',
      });
      return d;
    };

    const line = document.createElement('div');
    line.id = 'sra-ruler-line';
    Object.assign(line.style, {
      position: 'absolute', left: '0', right: '0',
      height: '2px', background: 'rgba(26,126,93,0.30)',
    });

    ruler.appendChild(mk('sra-ruler-top', 'top'));
    ruler.appendChild(mk('sra-ruler-bot', 'bottom'));
    ruler.appendChild(line);
    document.body.appendChild(ruler);
  }

  /* Vertical Japanese and Chinese read down columns, so the clear band runs
     vertically and the dimmed halves sit left and right. Drawing a horizontal
     band over vertical text hides the line being read. */
  function applyY(y) {
    const vertical = getVertical();
    const extent = vertical ? window.innerWidth : window.innerHeight;
    const top = document.getElementById('sra-ruler-top');
    const bot = document.getElementById('sra-ruler-bot');
    const ln  = document.getElementById('sra-ruler-line');
    if (!top || !bot || !ln) return;

    const near = Math.max(0, y - bandPx);
    const far  = Math.max(0, extent - y - bandPx);

    if (vertical) {
      Object.assign(top.style, { width: near + 'px', height: '100%', top: '0', bottom: 'auto', left: '0', right: 'auto' });
      Object.assign(bot.style, { width: far + 'px',  height: '100%', top: '0', bottom: 'auto', right: '0', left: 'auto' });
      Object.assign(ln.style,  { width: '2px', height: '100%', left: (y - 1) + 'px', top: '0', right: 'auto' });
    } else {
      Object.assign(top.style, { height: near + 'px', width: 'auto', left: '0', right: '0', top: '0', bottom: 'auto' });
      Object.assign(bot.style, { height: far + 'px',  width: 'auto', left: '0', right: '0', bottom: '0', top: 'auto' });
      Object.assign(ln.style,  { height: '2px', width: 'auto', left: '0', right: '0', top: (y - 1) + 'px' });
    }
  }

  function scheduleUpdate(rawY) {
    pendingY = rawY;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!enabled || pendingY === null) return;
      smoothY = smoothY === null ? pendingY
        : (1 - SMOOTH_K) * smoothY + SMOOTH_K * pendingY;
      applyY(smoothY);
    });
  }

  const onPointerMove = (e) => {
    if (!enabled) return;
    if (!cursorIsOnText(e.clientX, e.clientY)) return;
    curY = getVertical() ? e.clientX : e.clientY;
    curAt = Date.now();
    scheduleUpdate(curY);
  };

  /* Scrolling does not move the reading line — it is a fixed viewport
     position — but it does mean the reader is moving, so a stale cursor
     should stop winning. Re-resolving on scroll is what returns the band to
     the reading line once the mouse has been left behind. */
  const onScroll = () => { if (enabled) scheduleUpdate(resolveY()); };
  const onResize = () => { if (enabled) scheduleUpdate(resolveY()); };

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      ensureDOM();
      const ruler = document.getElementById(RULER_ID);
      if (ruler) ruler.style.display = 'block';

      // Start on the reading line rather than sliding in from nowhere.
      smoothY = readingLineY();
      applyY(smoothY);

      document.addEventListener('mousemove', onPointerMove, { passive: true });
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize, { passive: true });
      ticker = setInterval(() => scheduleUpdate(resolveY()), TICK_MS);
    },

    disable() {
      enabled = false;
      smoothY = null;
      gazeY = curY = null;
      clearInterval(ticker); ticker = null;
      document.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      const ruler = document.getElementById(RULER_ID);
      if (ruler) ruler.style.display = 'none';
    },

    /* Gaze samples, when there are any. Highest priority while fresh. */
    update(y) {
      if (!enabled || typeof y !== 'number' || Number.isNaN(y)) return;
      gazeY = y;
      gazeAt = Date.now();
      scheduleUpdate(y);
    },

    /* Called when the fused state changes. */
    adaptToState(state) {
      bandPx = BAND_BY_STATE[state] || DEFAULT_BAND_PX;
      if (enabled) scheduleUpdate(resolveY());
    },

    /* Which source the band is following. Exposed so nothing claims the
       camera is involved when it is not. */
    source() {
      const now = Date.now();
      if (gazeY !== null && now - gazeAt < GAZE_FRESH_MS)   return 'gaze';
      if (curY  !== null && now - curAt  < CURSOR_FRESH_MS) return 'cursor';
      return 'reading-line';
    },

    isEnabled() { return enabled; },
  };
}
