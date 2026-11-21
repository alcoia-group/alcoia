import { describe, it, expect } from 'vitest';
import { createReadingLineLearner, DEFAULT_LINE, MIN_LINE, MAX_LINE } from '../alcoia/src/content/signals/reading-line.js';
import { createParagraphTracker } from '../alcoia/src/content/signals/paragraph-tracker.js';

describe('reading line learner', () => {
  it('starts at the default and says so until it has seen anything', () => {
    const l = createReadingLineLearner();
    expect(l.value()).toBe(DEFAULT_LINE);
    expect(l.samples()).toBe(0);
  });

  it('a few samples move the line only a little; many move it most of the way', () => {
    const few = createReadingLineLearner();
    for (let i = 0; i < 3; i++) few.note(0.55);
    expect(few.value()).toBeGreaterThan(DEFAULT_LINE);
    expect(few.value()).toBeLessThan(0.45);
    const many = createReadingLineLearner();
    for (let i = 0; i < 120; i++) many.note(0.55);
    expect(many.value()).toBeGreaterThan(0.5);
  });

  it('a reader who reads high ends up with a high line, and the line stays inside its bounds', () => {
    const l = createReadingLineLearner();
    for (let i = 0; i < 400; i++) l.note(0.08);
    expect(l.value()).toBe(MIN_LINE);
    const h = createReadingLineLearner();
    for (let i = 0; i < 400; i++) h.note(0.93);
    expect(h.value()).toBe(MAX_LINE);
  });

  it('is the median, so a few odd samples do not drag it', () => {
    const l = createReadingLineLearner();
    for (let i = 0; i < 60; i++) l.note(0.5);
    for (let i = 0; i < 5; i++) l.note(0.9);
    expect(l.value()).toBeGreaterThan(0.45);
    expect(l.value()).toBeLessThan(0.52);
  });

  it('ignores positions that are chrome and gutters, and anything that is not a number', () => {
    const l = createReadingLineLearner();
    for (const bad of [0, 0.01, 0.99, 1, -1, NaN, undefined, null, 'x']) expect(l.note(bad)).toBe(false);
    expect(l.note(0.5, 0)).toBe(false);
    expect(l.samples()).toBe(0);
  });

  it('old samples fade, so a changed habit shows', () => {
    const l = createReadingLineLearner();
    for (let i = 0; i < 300; i++) l.note(0.3);
    for (let i = 0; i < 600; i++) l.note(0.55);
    expect(l.value()).toBeGreaterThan(0.5);
  });

  it('a value from the account seeds an empty learner only, and is bounded', () => {
    const l = createReadingLineLearner();
    expect(l.seed(0.52)).toBe(true);
    expect(l.value()).toBeGreaterThan(DEFAULT_LINE);
    expect(l.seed(0.3)).toBe(false); // it already has something
    const other = createReadingLineLearner();
    expect(other.seed(0.9)).toBe(false);
    expect(other.seed(NaN)).toBe(false);
    expect(other.value()).toBe(DEFAULT_LINE);
  });

  it('state round-trips, and a malformed saved state is refused', () => {
    const a = createReadingLineLearner();
    for (let i = 0; i < 50; i++) a.note(0.55);
    const b = createReadingLineLearner();
    expect(b.load(a.state())).toBe(true);
    expect(b.value()).toBe(a.value());
    const c = createReadingLineLearner();
    expect(c.load({ bins: [1, 2, 3], total: 6 })).toBe(false);
    expect(c.load(null)).toBe(false);
    expect(c.load({ bins: new Array(20).fill(-1) })).toBe(false);
    expect(c.value()).toBe(DEFAULT_LINE);
  });

  it('keeps no text, page or time: the saved state is twenty counts and a total', () => {
    const l = createReadingLineLearner();
    l.note(0.5);
    const s = l.state();
    expect(Object.keys(s).sort()).toEqual(['bins', 'total']);
    expect(s.bins).toHaveLength(20);
  });
});

/* A stand-in for the page: blocks at fixed positions in a 800px-high window. */
function pageOf(blocks, { scrollEnd = false } = {}) {
  const doc = {
    querySelectorAll: () => blocks.map((p) => ({
      innerText: p.text, textContent: p.text, name: p.name,
      getBoundingClientRect: () => ({ top: p.top, bottom: p.top + p.height, height: p.height }),
    })),
    scrollingElement: { scrollHeight: scrollEnd ? 2000 : 900, clientHeight: 800, scrollTop: scrollEnd ? 1200 : 0 },
  };
  return doc;
}
const WORDS = Array.from({ length: 40 }, (_, i) => 'word' + i).join(' ');

describe('paragraph tracker uses the learned line and the end of the page', () => {
  it('a different line picks a different paragraph', () => {
    const blocks = [{ name: 'a', text: WORDS, top: 100, height: 200 }, { name: 'b', text: WORDS, top: 320, height: 200 }];
    const high = createParagraphTracker({ document: pageOf(blocks), viewportHeight: () => 800, readingLine: 0.25 });
    high.update();
    expect(high.getActive().el.name).toBe('a'); // 0.25 * 800 = 200, inside a
    const low = createParagraphTracker({ document: pageOf(blocks), viewportHeight: () => 800, readingLine: () => 0.5 });
    low.update();
    expect(low.getActive().el.name).toBe('b'); // 400, inside b
  });

  it('the line is read again on every update, so learning takes effect at once', () => {
    const blocks = [{ name: 'a', text: WORDS, top: 100, height: 200 }, { name: 'b', text: WORDS, top: 320, height: 200 }];
    let line = 0.25;
    const t = createParagraphTracker({ document: pageOf(blocks), viewportHeight: () => 800, readingLine: () => line });
    t.update();
    expect(t.getActive().el.name).toBe('a');
    line = 0.5;
    t.update();
    expect(t.getActive().el.name).toBe('b');
  });

  it('at the end of the page the last paragraph counts even though it sits below the line', () => {
    // the last paragraph starts at 560, below the line at 320; the page cannot scroll further
    const blocks = [{ name: 'a', text: WORDS, top: 100, height: 300 }, { name: 'last', text: WORDS, top: 560, height: 200 }];
    const atEnd = createParagraphTracker({ document: pageOf(blocks, { scrollEnd: true }), viewportHeight: () => 800 });
    atEnd.update();
    expect(atEnd.getActive().el.name).toBe('last');
    // not at the end of the page: the paragraph nearest the line is still used, as before
    const notEnd = createParagraphTracker({ document: pageOf(blocks), viewportHeight: () => 800 });
    notEnd.update();
    expect(notEnd.getActive().el.name).toBe('a');
  });

  it('a scrolling box other than the window can say it is at its end', () => {
    const blocks = [{ name: 'a', text: WORDS, top: 100, height: 300 }, { name: 'last', text: WORDS, top: 560, height: 200 }];
    const t = createParagraphTracker({ document: pageOf(blocks), viewportHeight: () => 800, atEnd: () => true });
    t.update();
    expect(t.getActive().el.name).toBe('last');
  });

  it('the pointer still beats the line, at the end of the page too', () => {
    const blocks = [{ name: 'a', text: WORDS, top: 100, height: 300 }, { name: 'last', text: WORDS, top: 560, height: 200 }];
    const t = createParagraphTracker({ document: pageOf(blocks, { scrollEnd: true }), viewportHeight: () => 800 });
    t.update(150);
    expect(t.getActive().el.name).toBe('a');
  });
});
