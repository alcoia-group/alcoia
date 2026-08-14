/* paragraph-tracker.js — which paragraph is being read, from the viewport alone
 *
 * Why this exists: enterParagraph/leaveParagraph used to be called only from
 * inside onGaze(), so with the camera off — the default — they never fired.
 * No paragraph timing meant no WPM baseline, no speed_mismatch signal and no
 * reading-time expectation. Scroll backtrack was the only signal
 * that worked. This replaces the gaze point with the viewport, which is
 * always available and costs no permission.
 *
 * The active paragraph is the one crossing the reading line: a horizontal band
 * some way down the viewport, roughly where people hold their focus. That is a
 * heuristic, not a measurement, and it is deliberately the only one here — the
 * detectors downstream are what turn it into signals.
 */

import { countWords, detectLanguage, readingAxis } from './segmentation.js';

const TEXT_SELECTOR = 'p, li, blockquote';

/* Figures, tables, code blocks and bare images used to be invisible to this
 * tracker — not in BLOCK_SELECTOR, so never a candidate for the reading line.
 * A reader who stopped to study one didn't get their own dwell bucket; the
 * time landed on whichever text paragraph was nearest, inflating that
 * paragraph's elapsed reading time and making a reader studying a chart
 * register as "slow on easy text". Tracking them as candidates — with no
 * word-count floor, since most have little or no text — fixes the boundary;
 * `media: true` on the entry is what tells the caller not to run pace maths
 * against something that was never prose. `img`/`svg`/`canvas` already
 * wrapped in a tracked `figure` are excluded so a captioned image isn't
 * counted twice. */
const MEDIA_SELECTOR =
  'figure, table, pre, img:not(figure img), svg:not(figure svg), canvas:not(figure canvas)';
const BLOCK_SELECTOR = `${TEXT_SELECTOR}, ${MEDIA_SELECTOR}`;

function isMediaEl(el) {
  const tag = (el.tagName || el.nodeName || '').toLowerCase();
  return tag === 'figure' || tag === 'table' || tag === 'pre'
    || tag === 'img' || tag === 'svg' || tag === 'canvas';
}

/* Fraction of viewport height treated as the reading line. Slightly above
 * centre: readers sit ahead of the middle rather than on it. */
const READING_LINE = 0.4;

export function createParagraphTracker(opts = {}) {
  const minWords     = opts.minWords ?? 20;
  const now          = opts.now || (() => Date.now());
  const doc          = opts.document || (typeof document !== 'undefined' ? document : null);
  const viewportH    = opts.viewportHeight || (() => window.innerHeight);
  const viewportW    = opts.viewportWidth || (() => window.innerWidth);
  const readingLine  = opts.readingLine ?? READING_LINE;
  /* Read live: an SPA can change the page language without a reload, and a
     captured copy would keep counting words with the wrong segmenter. */
  const getLang      = opts.lang || (() => detectLanguage(doc));
  const getAxis      = opts.axis || (() => readingAxis(doc));

  let paragraphs = [];       // [{ el, index, words }]
  let indexOf    = new WeakMap();
  let active     = null;     // { el, index, enteredAt, words }
  let pending    = null;
  let lastScan   = 0;

  /* Was `t.split(/\s+/).length`, which returns 1 for an entire Chinese or
     Japanese paragraph — so every one of them fell under `minWords` and no
     paragraph on those pages was ever tracked. */
  function wordCount(el) {
    const t = (el.innerText || el.textContent || '').trim();
    return t ? countWords(t, getLang()) : 0;
  }

  /* Document order defines the index, which is what regression detection
   * compares against. Rescanned lazily — pages mutate. */
  function scan() {
    if (!doc) return;
    const found = [];
    let i = 0;
    for (const el of doc.querySelectorAll(BLOCK_SELECTOR)) {
      const media = isMediaEl(el);
      const words = media ? 0 : wordCount(el);
      if (!media && words < minWords) continue;
      const entry = { el, index: i++, words, media };
      found.push(entry);
      indexOf.set(el, entry.index);
    }
    paragraphs = found;
    lastScan = now();
  }

  /* `overrideY` is a measured reading position — currently the cursor, when the
   * reader is using it as a pointer. It beats the viewport heuristic outright
   * because it is an observation rather than an assumption. */
  /* Vertical Japanese and Chinese (writing-mode: vertical-rl) scroll sideways
     and read down columns, so the reading line is a vertical band and the
     relevant extent of a paragraph is its horizontal one. Everything else
     about the heuristic is unchanged; only the axis moves. */
  function elementAtReadingLine(overrideY) {
    if (!paragraphs.length) return null;
    const axis = getAxis();
    const span = axis.vertical ? viewportW() : viewportH();
    const frac = axis.vertical && axis.rtl ? 1 - readingLine : readingLine;
    const line = Number.isFinite(overrideY) && !axis.vertical ? overrideY : span * frac;

    let best = null;
    let bestDist = Infinity;

    for (const p of paragraphs) {
      let r;
      try { r = p.el.getBoundingClientRect(); } catch (e) { continue; }
      const near = axis.vertical ? r.left : r.top;
      const far  = axis.vertical ? r.right : r.bottom;
      if ((axis.vertical ? r.width : r.height) === 0) continue;
      // Straddling the line wins outright.
      if (near <= line && far >= line) return p;
      const dist = near > line ? near - line : line - far;
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    // Only fall back to the nearest paragraph if it is close to the line;
    // otherwise the reader is between blocks and we should say nothing.
    return bestDist < span * 0.35 ? best : null;
  }

  /* Call on scroll and on a slow interval. Returns a transition or null. */
  function update(overrideY) {
    if (!paragraphs.length || now() - lastScan > 10000) scan();

    const next = elementAtReadingLine(overrideY);
    const nextEl = next ? next.el : null;
    const activeEl = active ? active.el : null;
    if (nextEl === activeEl) return null;

    const t = now();
    const left = active
      ? { el: active.el, index: active.index, words: active.words, media: active.media, dwellMs: t - active.enteredAt }
      : null;

    active = next ? { el: next.el, index: next.index, words: next.words, media: next.media, enteredAt: t } : null;

    const transition = {
      type: 'paragraph_change',
      left,
      entered: active ? { el: active.el, index: active.index, words: active.words, media: active.media } : null,
      at: t,
    };
    pending = transition;
    return transition;
  }

  function signal() { const s = pending; pending = null; return s; }

  /* Discard in-flight tracking state without producing a transition — a
   * genuine SPA route change swaps the DOM out from under `paragraphs`, and
   * without this the next `update()` would report the OLD document's active
   * paragraph as "left", carrying its full stale dwell time into a
   * transition that syncParagraph() attributes to the NEW document's
   * coverage-gate key (documentKey() is read live, at record time). Callers
   * still need `rescan()` afterward to populate `paragraphs` from the new
   * DOM; this only clears state that would otherwise misattribute. */
  function reset() {
    paragraphs = [];
    indexOf = new WeakMap();
    active = null;
    pending = null;
    lastScan = 0;
  }

  return {
    update,
    signal,
    rescan: scan,
    reset,
    getActive: () => (active ? { ...active } : null),
    getIndex: (el) => (el && indexOf.has(el) ? indexOf.get(el) : null),
    // Default keeps counting every tracked candidate, media included — the
    // reading-line heuristic needs that to find a figure at all. Coverage
    // maths (coverage-gate.js) wants only the paragraphs that were ever
    // prose, since a media landmark can never itself be "read".
    count: (opts = {}) => (opts.excludeMedia ? paragraphs.filter((p) => !p.media).length : paragraphs.length),
  };
}
