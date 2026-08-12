// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createParagraphTracker } from '../alcoia/src/content/telemetry/paragraph-tracker.js';
import { createScrollRegressionDetector, FAST_RETURN_MS, SLOW_RETURN_MS } from '../alcoia/src/content/telemetry/scroll-regression.js';
import { createInteractionSignals, LONG_BLUR_MS } from '../alcoia/src/content/telemetry/interaction-signals.js';
import { createScrollDynamics } from '../alcoia/src/content/telemetry/scroll-dynamics.js';
import { createComprehensionMonitor } from '../alcoia/src/content/comprehension-monitor.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/* Minimal stand-in for the bits of the DOM the tracker touches. */
function fakeDocument(paras) {
  return {
    querySelectorAll: () => paras.map((p) => ({
      innerText: p.text,
      textContent: p.text,
      getBoundingClientRect: () => ({ top: p.top, bottom: p.top + p.height, height: p.height }),
      __name: p.name,
    })),
  };
}

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('paragraph-tracker', () => {
  it('ignores blocks below the word threshold', () => {
    const doc = fakeDocument([
      { name: 'short', text: 'too short', top: 100, height: 40 },
      { name: 'real',  text: words(50), top: 200, height: 200 },
    ]);
    const t = createParagraphTracker({ document: doc, viewportHeight: () => 800, minWords: 20 });
    t.rescan();
    expect(t.count()).toBe(1);
  });

  it('picks the paragraph straddling the reading line', () => {
    // Reading line at 0.4 * 800 = 320.
    const doc = fakeDocument([
      { name: 'a', text: words(50), top: 0,   height: 200 },   // 0-200
      { name: 'b', text: words(50), top: 250, height: 200 },   // 250-450, contains 320
      { name: 'c', text: words(50), top: 500, height: 200 },
    ]);
    const t = createParagraphTracker({ document: doc, viewportHeight: () => 800 });
    const transition = t.update();
    expect(transition.entered.index).toBe(1);
    expect(t.getActive().index).toBe(1);
  });

  it('reports dwell time when the reader moves on', () => {
    const clock = fixedClock();
    let scroll = 0;                   // both paragraphs move as the page scrolls
    const block = (docTop, wordCount) => ({
      innerText: words(wordCount), textContent: words(wordCount),
      getBoundingClientRect: () => ({ top: docTop - scroll, bottom: docTop - scroll + 200, height: 200 }),
    });
    const doc = { querySelectorAll: () => [block(250, 50), block(500, 60)] };
    const t = createParagraphTracker({ document: doc, viewportHeight: () => 800, now: clock.now });

    t.update();                       // reading line 320 sits inside 250-450
    expect(t.getActive().index).toBe(0);

    clock.advance(9000);
    scroll = 250;                     // paragraph 1 is now 250-450
    const moved = t.update();

    expect(moved.left.index).toBe(0);
    expect(moved.left.dwellMs).toBe(9000);
    expect(moved.entered.index).toBe(1);
  });

  it('says nothing when no paragraph is near the line', () => {
    const doc = fakeDocument([{ name: 'far', text: words(50), top: 5000, height: 200 }]);
    const t = createParagraphTracker({ document: doc, viewportHeight: () => 800 });
    t.update();
    expect(t.getActive()).toBeNull();
  });

  it('tracks a media block as a candidate even with no text', () => {
    // A table with no text used to be invisible (not in BLOCK_SELECTOR, and
    // even if it had been, empty text falls under any minWords floor). It
    // must show up as its own candidate regardless of word count.
    const doc = {
      querySelectorAll: () => [
        { tagName: 'p', innerText: words(50), textContent: words(50),
          getBoundingClientRect: () => ({ top: 0, bottom: 200, height: 200 }) },
        { tagName: 'table', innerText: '', textContent: '',
          getBoundingClientRect: () => ({ top: 250, bottom: 450, height: 200 }) },
      ],
    };
    const t = createParagraphTracker({ document: doc, viewportHeight: () => 800 });
    t.rescan();
    expect(t.count()).toBe(2);
    // Coverage maths (coverage-gate.js) wants only the paragraphs that were
    // ever prose — a figure can never itself be "read".
    expect(t.count({ excludeMedia: true })).toBe(1);
  });

  it("ends a paragraph's dwell at a figure instead of letting the figure's viewing time inflate it", () => {
    // Reproduces the bug: without a figure candidate in between, dwell on the
    // first paragraph kept accruing through the whole time the reader spent
    // on the chart, so an easy paragraph read at a normal pace looked like it
    // took far longer than its word count justified.
    const clock = fixedClock();
    let scroll = 0;
    const textBlock = (docTop) => ({
      tagName: 'p',
      innerText: words(50), textContent: words(50),
      getBoundingClientRect: () => ({ top: docTop - scroll, bottom: docTop - scroll + 200, height: 200 }),
    });
    const figureBlock = (docTop, height) => ({
      tagName: 'figure',
      innerText: '', textContent: '',
      getBoundingClientRect: () => ({ top: docTop - scroll, bottom: docTop - scroll + height, height }),
    });
    const doc = { querySelectorAll: () => [textBlock(250), figureBlock(500, 300), textBlock(900)] };
    const t = createParagraphTracker({ document: doc, viewportHeight: () => 800, now: clock.now });

    t.update();                          // line 320: paragraph (250-450) straddles
    expect(t.getActive().index).toBe(0);

    clock.advance(9000);
    scroll = 250;                        // paragraph -> 0-200; figure -> 250-550, straddles 320
    const toFigure = t.update();
    expect(toFigure.left.index).toBe(0);
    expect(toFigure.left.dwellMs).toBe(9000);   // bounded at the figure, not inflated by it
    expect(toFigure.entered.index).toBe(1);
    expect(toFigure.entered.media).toBe(true);

    clock.advance(4000);
    scroll = 700;                        // figure -> -200..100; next paragraph -> 200-400, straddles 320
    const toNext = t.update();
    expect(toNext.left.index).toBe(1);
    expect(toNext.left.media).toBe(true);
    expect(toNext.left.dwellMs).toBe(4000);     // the figure's own dwell, not folded into either paragraph
    expect(toNext.entered.index).toBe(2);
    expect(toNext.entered.media).toBe(false);
  });
});

/* Integration: paragraph-tracker feeding comprehension-monitor the way
 * orchestrator.js's syncParagraph() actually does — leaveParagraph() runs on
 * every exit, but enterParagraph() is skipped when the entered block carries
 * media: true. That skip is the fix; these tests exercise it end to end
 * rather than only checking the tracker's own dwellMs bookkeeping. */
describe('media dwell attribution end to end (paragraph-tracker + comprehension-monitor)', () => {
  function fakeChromeStorage() {
    const store = {};
    return {
      storage: {
        local: {
          get(keys, cb) {
            const result = {};
            for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
            cb(result);
          },
          set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
        },
      },
    };
  }

  const EASY = (n) => {
    const s = 'The cat sat on the mat and looked at the dog. ';
    return s.repeat(Math.ceil(n / 10)).trim();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    document.documentElement.lang = 'en';
    globalThis.chrome = fakeChromeStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.chrome;
  });

  /* Mirrors orchestrator.js's syncParagraph(): unconditional leaveParagraph()
   * on exit, enterParagraph() skipped for a media entry. */
  function syncParagraph(monitor, transition) {
    let signal = null;
    if (transition.left) signal = monitor.leaveParagraph();
    if (transition.entered?.el && !transition.entered.media) monitor.enterParagraph(transition.entered.el);
    return signal;
  }

  function textBlock(text, docTop, getScroll) {
    return {
      tagName: 'p', innerText: text, textContent: text,
      getBoundingClientRect: () => ({ top: docTop - getScroll(), bottom: docTop - getScroll() + 200, height: 200 }),
    };
  }

  function mediaBlock(tag, docTop, height, getScroll) {
    return {
      tagName: tag, innerText: '', textContent: '',
      getBoundingClientRect: () => ({ top: docTop - getScroll(), bottom: docTop - getScroll() + height, height }),
    };
  }

  function warmUpBaseline(monitor) {
    // too_slow only fires once a personal baseline exists (hasSamples()); without
    // one this test would pass trivially regardless of whether the fix works.
    const warm = EASY(120);
    for (let i = 0; i < 5; i++) {
      monitor.enterParagraph({ innerText: warm, textContent: warm });
      vi.advanceTimersByTime(25000);
      monitor.leaveParagraph();
    }
    expect(monitor.getBaselineWpm()).toBeGreaterThan(0);
  }

  it.each([['figure'], ['pre']])(
    'a long dwell on a %s between two paragraphs produces no too_slow signal against either neighbour',
    (mediaTag) => {
      const monitor = createComprehensionMonitor();
      warmUpBaseline(monitor);

      let scroll = 0;
      const doc = {
        querySelectorAll: () => [
          textBlock(EASY(120), 250, () => scroll),
          mediaBlock(mediaTag, 500, 300, () => scroll),
          textBlock(EASY(120), 900, () => scroll),
        ],
      };
      const tracker = createParagraphTracker({ document: doc, viewportHeight: () => 800 });

      let t = tracker.update();                 // enters paragraph A
      let sig = syncParagraph(monitor, t);
      expect(sig).toBeNull();
      expect(monitor.getCurrentExpectation()).not.toBeNull();   // A is being timed

      vi.advanceTimersByTime(25000);             // A read at the warm-up pace — not slow
      scroll = 250;                              // A -> 0-200; media -> 250-550, straddles 320
      t = tracker.update();
      sig = syncParagraph(monitor, t);
      expect(sig).toBeNull();                    // A's own pace was normal
      expect(t.entered.media).toBe(true);
      expect(monitor.getCurrentExpectation()).toBeNull();       // the media block is not timed at all

      // The reader studies the figure/code block for far longer than any text
      // paragraph this size would take. Under the old code this dwell either
      // fell through to whichever text paragraph was nearest, or kept accruing
      // to A — either way it was enough to trip too_slow. Here nothing is
      // timing it, so it cannot produce a signal against anything.
      vi.advanceTimersByTime(60000);
      scroll = 700;                              // media -> -200..100; C -> 200-400, straddles 320
      t = tracker.update();
      sig = syncParagraph(monitor, t);
      expect(sig).toBeNull();                    // nothing was ever entered for the media block
      expect(t.entered.media).toBe(false);
      expect(monitor.getCurrentExpectation()).not.toBeNull();   // C starts its own fresh timing

      vi.advanceTimersByTime(25000);             // C read at the same normal pace as A
      scroll = 5000;                             // scrolls everything far past the reading line
      t = tracker.update();
      sig = syncParagraph(monitor, t);
      expect(sig).toBeNull();                    // C's dwell is untouched by the 60s spent on the media block
    },
  );

  it('does not suppress a genuine too_slow signal on ordinary text — the skip is targeted at media, not blanket', () => {
    const monitor = createComprehensionMonitor();
    warmUpBaseline(monitor);

    let scroll = 0;
    const doc = {
      querySelectorAll: () => [
        textBlock(EASY(120), 250, () => scroll),
        textBlock(EASY(120), 500, () => scroll),
        textBlock(EASY(120), 900, () => scroll),
      ],
    };
    const tracker = createParagraphTracker({ document: doc, viewportHeight: () => 800 });

    let t = tracker.update();                    // enters paragraph A
    syncParagraph(monitor, t);

    vi.advanceTimersByTime(25000);                // A at the normal warm-up pace
    scroll = 250;
    t = tracker.update();
    expect(syncParagraph(monitor, t)).toBeNull();
    expect(t.entered.media).toBe(false);

    vi.advanceTimersByTime(25000 * 4);            // B read at a quarter of the established pace
    scroll = 700;
    t = tracker.update();
    const sig = syncParagraph(monitor, t);
    expect(sig).not.toBeNull();
    expect(sig.type).toBe('speed_mismatch');
    expect(sig.subtype).toBe('too_slow');
  });
});

describe('scroll-regression', () => {
  const change = (fromIdx, toIdx, at) => ({
    type: 'paragraph_change',
    left: fromIdx == null ? null : { index: fromIdx },
    entered: toIdx == null ? null : { index: toIdx, el: null },
    at,
  });

  it('ignores forward reading', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now });
    expect(d.update(change(null, 0, clock.now()))).toBeNull();
    expect(d.update(change(0, 1, clock.now()))).toBeNull();
    expect(d.update(change(1, 2, clock.now()))).toBeNull();
  });

  it('flags a return to an earlier paragraph', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now });
    d.update(change(null, 0, clock.now()));
    d.update(change(0, 1, clock.now()));
    clock.advance(5000);
    d.update(change(1, 2, clock.now()));
    clock.advance(5000);

    const sig = d.update(change(2, 0, clock.now()));
    expect(sig.type).toBe('regression');
    expect(sig.toIndex).toBe(0);
    expect(sig.distance).toBe(2);
  });

  it('separates a fast return from a slow one', () => {
    const fast = (() => {
      const clock = fixedClock();
      const d = createScrollRegressionDetector({ now: clock.now });
      d.update(change(null, 0, clock.now()));
      d.update(change(0, 1, clock.now()));
      clock.advance(FAST_RETURN_MS - 500);
      return d.update(change(1, 0, clock.now()));
    })();
    expect(fast.subtype).toBe('fast_return');

    const slow = (() => {
      const clock = fixedClock();
      const d = createScrollRegressionDetector({ now: clock.now });
      d.update(change(null, 0, clock.now()));
      d.update(change(0, 1, clock.now()));
      clock.advance(SLOW_RETURN_MS + 2000);
      return d.update(change(1, 0, clock.now()));
    })();
    expect(slow.subtype).toBe('slow_return');
  });

  it('holds a cooldown between regressions', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now });
    d.update(change(null, 0, clock.now()));
    d.update(change(0, 3, clock.now()));
    expect(d.update(change(3, 1, clock.now()))).toBeTruthy();
    clock.advance(1000);
    expect(d.update(change(1, 0, clock.now()))).toBeNull();
  });
});

describe('interaction-signals', () => {
  it('emits selection as corroboration, never as an assertion', () => {
    const s = createInteractionSignals({ now: fixedClock().now });
    const sig = s.update({ kind: 'selection', text: 'a reasonably long selection of text' });
    expect(sig.type).toBe('selection');
    expect(sig.assertable).toBe(false);
  });

  it('ignores a trivially short selection', () => {
    const s = createInteractionSignals({ now: fixedClock().now });
    expect(s.update({ kind: 'selection', text: 'hi' })).toBeNull();
  });

  it('marks a short copy as a term lookup', () => {
    const s = createInteractionSignals({ now: fixedClock().now });
    expect(s.update({ kind: 'copy', text: 'epistemic closure' }).subtype).toBe('term');
    expect(s.update({ kind: 'copy', text: words(20) }).subtype).toBe('passage');
  });

  it('reports a long absence followed by a return to the same paragraph', () => {
    const clock = fixedClock();
    const s = createInteractionSignals({ now: clock.now });
    s.update({ kind: 'blur', paragraphIndex: 4 });
    clock.advance(LONG_BLUR_MS + 60_000);
    const sig = s.update({ kind: 'focus', paragraphIndex: 4 });
    expect(sig.type).toBe('blur_return');
    expect(sig.assertable).toBe(true);
  });

  it('says nothing when the reader comes back and carries on forwards', () => {
    const clock = fixedClock();
    const s = createInteractionSignals({ now: clock.now });
    s.update({ kind: 'blur', paragraphIndex: 4 });
    clock.advance(LONG_BLUR_MS + 60_000);
    expect(s.update({ kind: 'focus', paragraphIndex: 5 })).toBeNull();
  });

  it('says nothing about a short interruption', () => {
    const clock = fixedClock();
    const s = createInteractionSignals({ now: clock.now });
    s.update({ kind: 'blur', paragraphIndex: 4 });
    clock.advance(5000);
    expect(s.update({ kind: 'focus', paragraphIndex: 4 })).toBeNull();
  });
});

describe('scroll-dynamics', () => {
  it('calls steady scrolling smooth', () => {
    const clock = fixedClock();
    const d = createScrollDynamics({ now: clock.now });
    let sig = null;
    for (let i = 0; i < 10; i++) { clock.advance(300); sig = d.update(i * 60, clock.now()); }
    expect(sig.subtype).toBe('smooth');
    expect(sig.assertable).toBe(false);
  });

  it('calls reversing, bursty scrolling hunting', () => {
    const clock = fixedClock();
    const d = createScrollDynamics({ now: clock.now });
    const path = [0, 900, 200, 1400, 150, 1700, 300, 2000];
    let sig = null;
    for (const y of path) { clock.advance(120); sig = d.update(y, clock.now()); }
    expect(sig.subtype).toBe('hunting');
    expect(sig.reversals).toBeGreaterThanOrEqual(2);
  });

  it('abstains until it has enough samples', () => {
    const clock = fixedClock();
    const d = createScrollDynamics({ now: clock.now });
    clock.advance(200);
    expect(d.update(100, clock.now())).toBeNull();
  });
});
