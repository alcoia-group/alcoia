// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createParagraphTracker } from '../alcoia/src/content/signals/paragraph-tracker.js';
import { createScrollRegressionDetector, FAST_RETURN_MS, SLOW_RETURN_MS } from '../alcoia/src/content/signals/scroll-regression.js';
import { createInteractionSignals, LONG_BLUR_MS } from '../alcoia/src/content/signals/interaction-signals.js';
import { createScrollDynamics } from '../alcoia/src/content/signals/scroll-dynamics.js';
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

/* Item 30b: an injected block source lets a non-DOM reading surface (a PDF
 * viewer's own paragraph model, wired up in a later item) drive this same
 * tracker. These blocks are plain objects, not real DOM elements — only
 * getBoundingClientRect() is required, since that is all elementAtReadingLine()
 * calls on them; words/media are supplied directly rather than computed. */
describe('paragraph-tracker: injected block source (item 30b)', () => {
  function block(top, height, words, media = false) {
    return { el: { getBoundingClientRect: () => ({ top, bottom: top + height, height }) }, words, media };
  }

  it('drives the same transition an equivalent DOM layout would', () => {
    // Mirrors "picks the paragraph straddling the reading line" above,
    // 1:1, but via blockSource instead of document.querySelectorAll.
    const blocks = [
      block(0, 200, 50),     // 0-200
      block(250, 200, 50),   // 250-450, contains the 320 reading line
      block(500, 200, 50),
    ];
    const t = createParagraphTracker({ viewportHeight: () => 800, blockSource: () => blocks });
    const transition = t.update();
    expect(transition.entered.index).toBe(1);
    expect(t.getActive().index).toBe(1);
  });

  it('ignores an injected block below the word threshold, same as the DOM path', () => {
    const blocks = [
      block(100, 40, 5),         // too short
      block(200, 200, 50),       // real
    ];
    const t = createParagraphTracker({ document: null, viewportHeight: () => 800, minWords: 20, blockSource: () => blocks });
    t.rescan();
    expect(t.count()).toBe(1);
  });

  it('suppresses pace attribution on an injected media block, same as the DOM path', () => {
    const blocks = [
      block(0, 200, 50, false),
      block(250, 200, 0, true),   // media: no word floor, still a candidate
    ];
    const t = createParagraphTracker({ viewportHeight: () => 800, blockSource: () => blocks });
    t.rescan();
    expect(t.count()).toBe(2);
    expect(t.count({ excludeMedia: true })).toBe(1);

    const transition = t.update();
    expect(transition.entered.media).toBe(true);
  });

  it('assigns sequential document-order indices from blockSource() order, which scroll-regression.js consumes unchanged', () => {
    const blocks = [block(0, 200, 50), block(250, 200, 50), block(500, 200, 50)];
    const t = createParagraphTracker({ viewportHeight: () => 800, blockSource: () => blocks });
    t.rescan();
    expect(blocks.map((b) => t.getIndex(b.el))).toEqual([0, 1, 2]);

    // scroll-regression.js only ever reads transition.left.index/.entered.index
    // and left.dwellMs as plain data — it has no DOM dependency — so feeding
    // it transitions produced from injected blocks exercises the real
    // integration, not just the tracker in isolation. Genuine re-read
    // classification needs a baseline dwell and a subsequent resolving
    // transition (see scroll-regression.js's own header), so this now runs
    // the full sequence rather than a single forward-then-back pair.
    const reg = createScrollRegressionDetector({ now: fixedClock().now, minDistance: 1, cooldown: 0 });
    t.update();                                  // enters index 1 (line at 320)
    reg.update(t.signal());
    const toTwo   = { type: 'paragraph_change', left: { index: 1, dwellMs: 8000 }, entered: { index: 2 }, at: 2000 };
    reg.update(toTwo);
    const toThree = { type: 'paragraph_change', left: { index: 2, dwellMs: 3000 }, entered: { index: 3 }, at: 3000 };
    reg.update(toThree);
    const jumpBack = { type: 'paragraph_change', left: { index: 3, dwellMs: 2000 }, entered: { index: 1 }, at: 4000 };
    expect(reg.update(jumpBack)).toBeNull();     // distance 2, watched — not yet counted
    const leaveOne = { type: 'paragraph_change', left: { index: 1, dwellMs: 6000 }, entered: { index: 4 }, at: 5000 };
    const regression = reg.update(leaveOne);      // dwelled 6s back, comparable to the original 8s
    expect(regression.type).toBe('regression');
    expect(regression.toIndex).toBe(1);
  });

  it('leaves the DOM path completely unchanged when no blockSource is supplied', () => {
    // Same fixture/expectations as "picks the paragraph straddling the reading
    // line" above, run again here to pin that omitting blockSource is a no-op.
    const doc = fakeDocument([
      { name: 'a', text: words(50), top: 0,   height: 200 },
      { name: 'b', text: words(50), top: 250, height: 200 },
      { name: 'c', text: words(50), top: 500, height: 200 },
    ]);
    const t = createParagraphTracker({ document: doc, viewportHeight: () => 800 });
    const transition = t.update();
    expect(transition.entered.index).toBe(1);
    expect(t.getActive().index).toBe(1);
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
  const change = (fromIdx, toIdx, at, dwellMs) => ({
    type: 'paragraph_change',
    left: fromIdx == null ? null : { index: fromIdx, dwellMs },
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

  /* A jump back is watched, not counted, the moment it happens — genuine
   * vs. correction can only be told apart once the reader leaves the
   * re-visited paragraph again and its dwell there is actually known. */
  it('flags a genuine re-read: a large backward jump followed by substantial dwell once back', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now });
    d.update(change(null, 0, clock.now()));
    clock.advance(8000);
    d.update(change(0, 1, clock.now(), 8000));            // leave 0 (original dwell 8s) -> enter 1
    clock.advance(3000);
    d.update(change(1, 2, clock.now(), 3000));             // leave 1 -> enter 2 (maxIndexReached = 2)
    clock.advance(5000);
    const jumpBack = d.update(change(2, 0, clock.now(), 5000));   // leave 2 -> enter 0: distance 2, watched
    expect(jumpBack).toBeNull();

    clock.advance(7000);                                    // stays at 0 almost as long as the first visit
    const sig = d.update(change(0, 3, clock.now(), 7000));  // leave 0 again -> resolves the jump
    expect(sig.type).toBe('regression');
    expect(sig.toIndex).toBe(0);
    expect(sig.distance).toBe(2);
    expect(sig.returnDwellMs).toBe(7000);
    expect(sig.originalDwellMs).toBe(8000);
    expect(sig.sameIndexRereadCount).toBe(1);
  });

  it('a small backward glance never counts as a genuine re-read, however long the dwell once back', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now });
    d.update(change(null, 0, clock.now()));
    clock.advance(8000);
    d.update(change(0, 1, clock.now(), 8000));              // original dwell on 0: 8s
    clock.advance(5000);
    const jumpBack = d.update(change(1, 0, clock.now(), 5000));   // distance 1 only
    expect(jumpBack).toBeNull();
    clock.advance(8000);                                     // a long dwell back — still not enough
    const sig = d.update(change(0, 2, clock.now(), 8000));
    expect(sig).toBeNull();
    expect(d.signal()).toBeNull();
  });

  it('a large jump followed by an immediate continue is a quick correction, not a re-read', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now });
    d.update(change(null, 0, clock.now()));
    clock.advance(8000);
    d.update(change(0, 1, clock.now(), 8000));
    clock.advance(3000);
    d.update(change(1, 2, clock.now(), 3000));               // maxIndexReached = 2
    clock.advance(5000);
    const jumpBack = d.update(change(2, 0, clock.now(), 5000));   // distance 2, watched
    expect(jumpBack).toBeNull();
    clock.advance(400);                                       // barely there before moving on
    const sig = d.update(change(0, 3, clock.now(), 400));
    expect(sig).toBeNull();
    expect(d.signal()).toBeNull();
  });

  it('never asserts a genuine re-read against a paragraph with no recorded original dwell — ambiguous, not forced into a category', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now });
    d.update(change(null, 0, clock.now()));
    clock.advance(1000);
    d.update(change(0, 1, clock.now(), 1000));                 // dwell on 0 recorded
    clock.advance(500);
    d.update(change(1, 5, clock.now(), 500));                   // jumps straight to 5 — paragraph 2 never visited at all
    clock.advance(3000);
    // distance 5 -> 2 is 3, well past largeDistance — but there is no
    // baseline dwell on 2 to judge a return against, so even a long dwell
    // back must not be forced into "genuine" on distance alone.
    const jumpBack = d.update(change(5, 2, clock.now(), 3000));
    expect(jumpBack).toBeNull();
    clock.advance(9000);                                         // a very long dwell back
    const sig = d.update(change(2, 6, clock.now(), 9000));
    expect(sig).toBeNull();
    expect(d.signal()).toBeNull();
  });

  it('separates a fast return from a slow one', () => {
    const fast = (() => {
      const clock = fixedClock();
      const d = createScrollRegressionDetector({ now: clock.now });
      d.update(change(null, 0, clock.now()));
      clock.advance(500);
      d.update(change(0, 1, clock.now(), 500));               // original dwell on 0: 0.5s
      clock.advance(500);
      d.update(change(1, 2, clock.now(), 500));                // maxIndexReached = 2
      clock.advance(FAST_RETURN_MS - 1000);                     // total latency since leaving 0 stays under FAST_RETURN_MS
      const jumpBack = d.update(change(2, 0, clock.now(), 500));
      expect(jumpBack).toBeNull();
      clock.advance(700);                                       // genuinely re-reads it (>= 0.6 * 500)
      return d.update(change(0, 3, clock.now(), 700));
    })();
    expect(fast.subtype).toBe('fast_return');

    const slow = (() => {
      // Slow returns already resolve to on_pace downstream and were never
      // struggle evidence — exempt from the genuine/correction distinction,
      // so this is unchanged: it still emits immediately.
      const clock = fixedClock();
      const d = createScrollRegressionDetector({ now: clock.now });
      d.update(change(null, 0, clock.now()));
      d.update(change(0, 1, clock.now(), 8000));
      clock.advance(SLOW_RETURN_MS + 2000);
      return d.update(change(1, 0, clock.now(), 8000));
    })();
    expect(slow.subtype).toBe('slow_return');
  });

  it('holds a cooldown between regressions', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now, cooldown: 20000 });

    d.update(change(null, 0, clock.now()));
    clock.advance(5000);
    d.update(change(0, 1, clock.now(), 5000));                 // original dwell on 0: 5s
    clock.advance(3000);
    d.update(change(1, 2, clock.now(), 3000));                  // maxIndexReached = 2
    clock.advance(4000);
    d.update(change(2, 0, clock.now(), 4000));                   // distance 2, watched
    clock.advance(6000);
    const first = d.update(change(0, 3, clock.now(), 6000));     // genuine: 6000 >= 0.6 * 5000
    expect(first.type).toBe('regression');

    // A second attempt well inside the cooldown window never even gets
    // watched, so there is nothing left to resolve later either.
    clock.advance(1000);
    d.update(change(3, 4, clock.now(), 1000));                   // maxIndexReached = 4
    clock.advance(1000);
    const secondJump = d.update(change(4, 0, clock.now(), 1000));
    expect(secondJump).toBeNull();
    clock.advance(6000);
    const second = d.update(change(0, 5, clock.now(), 6000));
    expect(second).toBeNull();
  });

  it('repeated genuine re-reads of the SAME paragraph count up — evidence state-engine.js reads as confusion', () => {
    const clock = fixedClock();
    const d = createScrollRegressionDetector({ now: clock.now, cooldown: 0 });

    d.update(change(null, 0, clock.now()));
    clock.advance(6000);
    d.update(change(0, 1, clock.now(), 6000));                  // original dwell on 0: 6s

    // Each round must pick up from wherever the previous one actually left
    // off, or `left.index` would claim a position the reader was never at.
    let cursor = 1;
    function genuineRereadOfZero() {
      const mid = cursor + 1;
      clock.advance(2000);
      d.update(change(cursor, mid, clock.now(), 2000));           // maxIndexReached advances past 0 again
      clock.advance(1000);
      d.update(change(mid, 0, clock.now(), 1000));                 // distance >= 2, watched
      clock.advance(4000);                                          // genuine dwell (>= 0.6 * 6000)
      const sig = d.update(change(0, mid + 1, clock.now(), 4000));
      cursor = mid + 1;
      return sig;
    }

    const first = genuineRereadOfZero();
    expect(first.sameIndexRereadCount).toBe(1);
    const second = genuineRereadOfZero();
    expect(second.sameIndexRereadCount).toBe(2);
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
