/* paragraph-tracker.js — which paragraph is being read, from the viewport alone
 *
 * Why this exists: enterParagraph/leaveParagraph used to be called only from
 * inside onGaze(), so with the camera off — the default — they never fired.
 * No paragraph timing meant no WPM baseline, no speed_mismatch signal and no
 * reading-time expectation. Scroll backtrack was the only telemetry signal
 * that worked. This replaces the gaze point with the viewport, which is
 * always available and costs no permission.
 *
 * The active paragraph is the one crossing the reading line: a horizontal band
 * some way down the viewport, roughly where people hold their focus. That is a
 * heuristic, not a measurement, and it is deliberately the only one here — the
 * detectors downstream are what turn it into signals.
 */

const BLOCK_SELECTOR = 'p, li, blockquote';

/* Fraction of viewport height treated as the reading line. Slightly above
 * centre: readers sit ahead of the middle rather than on it. */
const READING_LINE = 0.4;

export function createParagraphTracker(opts = {}) {
  const minWords     = opts.minWords ?? 20;
  const now          = opts.now || (() => Date.now());
  const doc          = opts.document || (typeof document !== 'undefined' ? document : null);
  const viewportH    = opts.viewportHeight || (() => window.innerHeight);
  const readingLine  = opts.readingLine ?? READING_LINE;

  let paragraphs = [];       // [{ el, index, words }]
  let indexOf    = new WeakMap();
  let active     = null;     // { el, index, enteredAt, words }
  let pending    = null;
  let lastScan   = 0;

  function wordCount(el) {
    const t = (el.innerText || el.textContent || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  /* Document order defines the index, which is what regression detection
   * compares against. Rescanned lazily — pages mutate. */
  function scan() {
    if (!doc) return;
    const found = [];
    let i = 0;
    for (const el of doc.querySelectorAll(BLOCK_SELECTOR)) {
      const words = wordCount(el);
      if (words < minWords) continue;
      const entry = { el, index: i++, words };
      found.push(entry);
      indexOf.set(el, entry.index);
    }
    paragraphs = found;
    lastScan = now();
  }

  function elementAtReadingLine() {
    if (!paragraphs.length) return null;
    const line = viewportH() * readingLine;
    let best = null;
    let bestDist = Infinity;

    for (const p of paragraphs) {
      let r;
      try { r = p.el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.height === 0) continue;
      // Straddling the line wins outright.
      if (r.top <= line && r.bottom >= line) return p;
      const dist = r.top > line ? r.top - line : line - r.bottom;
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    // Only fall back to the nearest paragraph if it is close to the line;
    // otherwise the reader is between blocks and we should say nothing.
    return bestDist < viewportH() * 0.35 ? best : null;
  }

  /* Call on scroll and on a slow interval. Returns a transition or null. */
  function update() {
    if (!paragraphs.length || now() - lastScan > 10000) scan();

    const next = elementAtReadingLine();
    const nextEl = next ? next.el : null;
    const activeEl = active ? active.el : null;
    if (nextEl === activeEl) return null;

    const t = now();
    const left = active
      ? { el: active.el, index: active.index, words: active.words, dwellMs: t - active.enteredAt }
      : null;

    active = next ? { el: next.el, index: next.index, words: next.words, enteredAt: t } : null;

    const transition = {
      type: 'paragraph_change',
      left,
      entered: active ? { el: active.el, index: active.index, words: active.words } : null,
      at: t,
    };
    pending = transition;
    return transition;
  }

  function signal() { const s = pending; pending = null; return s; }

  return {
    update,
    signal,
    rescan: scan,
    getActive: () => (active ? { ...active } : null),
    getIndex: (el) => (el && indexOf.has(el) ? indexOf.get(el) : null),
    count: () => paragraphs.length,
  };
}
