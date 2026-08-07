import { describe, it, expect } from 'vitest';
import { createCursorTracker } from '../alcoia/src/content/telemetry/cursor-tracking.js';
import { createProgressionEntropy } from '../alcoia/src/content/telemetry/progression-entropy.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('cursor-tracking', () => {
  it('recognises a cursor being used to follow text', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    let sig = null;
    for (let i = 0; i < 12; i++) {
      clock.advance(250);
      sig = c.update(300 + (i % 3), 200 + i * 18, clock.now());   // steady descent
    }
    expect(sig.tracking).toBe(true);
    expect(c.getPointerY()).toBeCloseTo(200 + 11 * 18, 0);
  });

  it('does not mistake reaching for the scrollbar for reading', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    let sig = null;
    // One big jump across the screen, then nothing resembling descent.
    const path = [[300, 200], [305, 210], [310, 215], [1200, 900], [1200, 905], [1198, 903], [1200, 902], [1199, 904]];
    for (const [x, y] of path) { clock.advance(120); sig = c.update(x, y, clock.now()); }
    expect(sig.tracking).toBe(false);
    expect(c.getPointerY()).toBeNull();
  });

  it('says nothing about a stationary cursor', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    let sig = null;
    for (let i = 0; i < 12; i++) { clock.advance(200); sig = c.update(400, 300, clock.now()); }
    expect(sig.tracking).toBe(false);
    expect(sig.correlation).toBeNull();
  });

  it('stops offering a position once the hand leaves the mouse', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now, idleMs: 2000 });
    for (let i = 0; i < 12; i++) { clock.advance(200); c.update(300, 200 + i * 20, clock.now()); }
    expect(c.getPointerY()).not.toBeNull();
    clock.advance(5000);
    expect(c.getPointerY()).toBeNull();
    expect(c.isTracking()).toBe(false);
  });

  it('abstains until it has enough movement to judge', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    clock.advance(100);
    expect(c.update(300, 200, clock.now())).toBeNull();
  });
});

describe('progression-entropy', () => {
  const change = (leftIndex, dwellMs) => ({
    type: 'paragraph_change',
    left: { index: leftIndex, dwellMs },
    entered: { index: leftIndex + 1 },
    at: 0,
  });

  it('waits for enough paragraphs before saying anything', () => {
    const p = createProgressionEntropy({ minParagraphs: 5 });
    for (let i = 0; i < 4; i++) expect(p.update(change(i, 8000))).toBeNull();
    expect(p.update(change(4, 8000))).toBeTruthy();
  });

  it('calls even, brief attention across the page skimming', () => {
    const p = createProgressionEntropy({ minParagraphs: 5 });
    let sig = null;
    for (let i = 0; i < 8; i++) sig = p.update(change(i, 1000 + (i % 2) * 50));
    expect(sig.subtype).toBe('skimming');
    expect(sig.normalized).toBeGreaterThan(0.95);
    expect(sig.assertable).toBe(false);
  });

  it('calls even but substantial attention reading, not skimming', () => {
    const p = createProgressionEntropy({ minParagraphs: 5 });
    let sig = null;
    for (let i = 0; i < 8; i++) sig = p.update(change(i, 20000 + (i % 2) * 500));
    expect(sig.subtype).toBe('reading');
  });

  it('calls a session with a few big stalls uneven', () => {
    const p = createProgressionEntropy({ minParagraphs: 5 });
    let sig = null;
    const dwells = [1000, 1000, 90000, 1000, 1000, 80000, 1000, 1000];
    dwells.forEach((d, i) => { sig = p.update(change(i, d)); });
    expect(sig.subtype).toBe('uneven');
    expect(sig.normalized).toBeLessThan(0.75);
  });

  it('ignores transitions with no dwell recorded', () => {
    const p = createProgressionEntropy({ minParagraphs: 2 });
    expect(p.update({ type: 'paragraph_change', left: null, entered: { index: 1 }, at: 0 })).toBeNull();
    expect(p.update({ type: 'paragraph_change', left: { index: 0, dwellMs: 0 }, entered: null, at: 0 })).toBeNull();
    expect(p.stats().paragraphs).toBe(0);
  });
});
