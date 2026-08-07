import { describe, it, expect } from 'vitest';
import { createParagraphTracker } from '../alcoia/src/content/telemetry/paragraph-tracker.js';
import { createScrollRegressionDetector, FAST_RETURN_MS, SLOW_RETURN_MS } from '../alcoia/src/content/telemetry/scroll-regression.js';
import { createInteractionSignals, LONG_BLUR_MS } from '../alcoia/src/content/telemetry/interaction-signals.js';
import { createScrollDynamics } from '../alcoia/src/content/telemetry/scroll-dynamics.js';

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
