import { describe, it, expect } from 'vitest';
import { createCursorTracker } from '../alcoia/src/content/signals/cursor-tracking.js';
import { createProgressionEntropy } from '../alcoia/src/content/signals/progression-entropy.js';

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

  /* Supersedes the old "has no signal() or other engine-emission surface"
   * pin. That test deliberately fixed the ABSENCE of a signal() path after
   * the cursor_reading defect (CLAUDE.md, Known defects): a `type:
   * 'cursor_reading'` object used to be emitted via signal() but nothing
   * ever wired state-engine.js's CORROBORATION table for it and
   * orchestrator.js never called signal() to drain it, so it was produced
   * and silently discarded — the dead path was deleted rather than wired
   * up retroactively. This task is the deliberate decision CLAUDE.md said
   * that revival would require: a real CORROBORATION entry
   * (cursor_kinematics), a real drain in orchestrator.js's pumpSignals(),
   * and a different, validated signal shape — mind-wandering kinematics,
   * not the old reading-position judgement. The shape only, confirmed here;
   * behaviour is covered by the describe block below. */
  it('has a signal() surface again, deliberately, with the new shape', () => {
    const c = createCursorTracker();
    expect(typeof c.signal).toBe('function');
    expect(Object.keys(c).sort()).toEqual(['getPointerY', 'isTracking', 'reset', 'signal', 'update']);
  });

  it('a reader who never moves the mouse gets no signal at all — never zero events read as evidence of anything', () => {
    const c = createCursorTracker();
    expect(c.signal()).toBeNull();
  });
});

describe('cursor-tracking — mind-wandering kinematics (revived, corroboration-only)', () => {
  it('flags a real axis-flip pattern — cursor repeatedly reversing direction, well past jitter', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    let y = 200;
    // Deliberately zig-zags x by 20px every step, well above jitter noise,
    // while y still advances so this cannot be mistaken for a stationary cursor.
    const xs = [300, 320, 300, 320, 300, 320, 300, 320, 300, 320];
    let sig = null;
    for (const x of xs) {
      clock.advance(150);
      y += 4;
      c.update(x, y, clock.now());
      sig = c.signal() ?? sig;
    }
    expect(sig).not.toBeNull();
    expect(sig.type).toBe('cursor_kinematics');
    expect(sig.subtype).toBe('mind_wandering');
    expect(sig.axisFlipRatio).toBeGreaterThan(0.35);
    expect(sig.initiationDelayMs).toBeNull();
  });

  it('flags a slow resumption after a real pause — the response-initiation-delay proxy', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now, resumeDelayMs: 5000 });
    // Ordinary smooth downward tracking first, same shape as the
    // "recognises a cursor being used to follow text" case above.
    for (let i = 0; i < 8; i++) {
      clock.advance(200);
      c.update(300, 200 + i * 18, clock.now());
    }
    c.signal(); // drain anything from the warm-up, isolate the pause below
    clock.advance(5500); // a real pause, past resumeDelayMs
    c.update(300, 400, clock.now());
    const sig = c.signal();
    expect(sig).not.toBeNull();
    expect(sig.subtype).toBe('mind_wandering');
    expect(sig.initiationDelayMs).toBe(5500);
  });

  it('an ordinary short pause between moves is not evidence of anything', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now, resumeDelayMs: 5000 });
    for (let i = 0; i < 8; i++) {
      clock.advance(200);
      c.update(300, 200 + i * 18, clock.now());
    }
    c.signal();
    clock.advance(1200); // well under resumeDelayMs — a normal reading pause
    c.update(300, 400, clock.now());
    expect(c.signal()).toBeNull();
  });

  it('smooth reading-tracking movement (the recognises-cursor-as-pointer case) produces no mind-wandering signal', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    let sig = null;
    for (let i = 0; i < 12; i++) {
      clock.advance(250);
      c.update(300 + (i % 3), 200 + i * 18, clock.now());   // same fixture as the reading-pointer test
      sig = c.signal();
    }
    expect(sig).toBeNull();
  });

  it('drains once and clears, same as every other detector\'s signal()', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    let y = 200;
    for (const x of [300, 320, 300, 320, 300, 320, 300, 320]) {
      clock.advance(150);
      y += 4;
      c.update(x, y, clock.now());
    }
    expect(c.signal()).not.toBeNull();
    expect(c.signal()).toBeNull();
  });

  it('reset() clears any pending kinematics along with everything else', () => {
    const clock = fixedClock();
    const c = createCursorTracker({ now: clock.now });
    let y = 200;
    for (const x of [300, 320, 300, 320, 300, 320, 300, 320]) {
      clock.advance(150);
      y += 4;
      c.update(x, y, clock.now());
    }
    c.reset();
    expect(c.signal()).toBeNull();
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
