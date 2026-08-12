import { describe, it, expect, vi } from 'vitest';
import { createReadingStateEngine, STATES } from '../alcoia/src/content/state-engine.js';

/* A controllable clock so nothing here depends on wall time. */
function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function engineAt(clock) {
  return createReadingStateEngine({ now: clock.now });
}

describe('default behaviour', () => {
  it('starts unknown with no confidence', () => {
    const e = engineAt(fixedClock());
    expect(e.getState().label).toBe(STATES.UNKNOWN);
    expect(e.getState().confidence).toBe(0);
  });

  it('stays unknown when given nothing', () => {
    const e = engineAt(fixedClock());
    const s = e.update({});
    expect(s.label).toBe(STATES.UNKNOWN);
    expect(s.evidence).toEqual([]);
  });
});

describe('telemetry drives the state', () => {
  it('too_slow becomes struggling and says why in the reader\'s terms', () => {
    const e = engineAt(fixedClock());
    const s = e.update({
      telemetry: {
        type: 'speed_mismatch', subtype: 'too_slow',
        actualWpm: 90, baselineWpm: 225, readability: { grade: 'standard' },
      },
    });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.confidence).toBeGreaterThan(0.5);
    expect(s.evidence[0]).toMatch(/2\.5x slower/);
  });

  it('too_fast becomes skimming', () => {
    const e = engineAt(fixedClock());
    const s = e.update({
      telemetry: {
        type: 'speed_mismatch', subtype: 'too_fast',
        readability: { grade: 'difficult' },
      },
    });
    expect(s.label).toBe(STATES.SKIMMING);
    expect(s.evidence[0]).toMatch(/dense paragraph quickly/);
  });

  it('backtrack becomes struggling and reports the distance', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ telemetry: { type: 'backtrack', backtrackPx: 240 } });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.evidence[0]).toMatch(/scrolled back 240px/);
  });
});

describe('P2 telemetry signals', () => {
  it('a fast return is struggling and outranks an ordinary one', () => {
    const fast = engineAt(fixedClock()).update({
      telemetry: { type: 'regression', subtype: 'fast_return', distance: 2, latencyMs: 1200 },
    });
    const ordinary = engineAt(fixedClock()).update({
      telemetry: { type: 'regression', subtype: 'return', distance: 2, latencyMs: 5000 },
    });
    expect(fast.label).toBe(STATES.STRUGGLING);
    expect(ordinary.label).toBe(STATES.STRUGGLING);
    expect(fast.confidence).toBeGreaterThan(ordinary.confidence);
    expect(fast.evidence[0]).toMatch(/jumped straight back 2 paragraphs/);
  });

  it('a slow return is competent reading, not struggling', () => {
    const s = engineAt(fixedClock()).update({
      telemetry: { type: 'regression', subtype: 'slow_return', distance: 1, latencyMs: 25000 },
    });
    expect(s.label).toBe(STATES.ON_PACE);
    expect(s.evidence[0]).toMatch(/went back a paragraph to review/);
  });

  it('returning to the same paragraph after a long absence is struggling', () => {
    const s = engineAt(fixedClock()).update({
      telemetry: { type: 'blur_return', subtype: 'resumed_same', blurMs: 180_000, paragraphIndex: 3 },
    });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.evidence[0]).toMatch(/after 3 minutes away/);
  });

  it('takes the strongest assertion when several arrive together', () => {
    const s = engineAt(fixedClock()).update({
      telemetry: [
        { type: 'regression', subtype: 'return', distance: 1, latencyMs: 5000 },
        { type: 'speed_mismatch', subtype: 'too_slow', actualWpm: 90, baselineWpm: 225 },
      ],
    });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.evidence[0]).toMatch(/slower than your usual pace/);
  });
});

describe('corroborating signals raise confidence but never assert', () => {
  it.each([
    ['selection', { type: 'selection', assertable: false, length: 40 }],
    ['copy', { type: 'copy', assertable: false, subtype: 'term', length: 18 }],
    ['scroll_jerk', { type: 'scroll_jerk', assertable: false, subtype: 'hunting', jerk: 0.05 }],
  ])('%s alone produces nothing', (_name, sig) => {
    const s = engineAt(fixedClock()).update({ telemetry: sig });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('a copy alongside a struggling signal raises confidence and is reported', () => {
    const clock = fixedClock();
    const alone = engineAt(clock).update({ telemetry: { type: 'backtrack', backtrackPx: 200 } });
    const withCopy = engineAt(clock).update({
      telemetry: [
        { type: 'backtrack', backtrackPx: 200 },
        { type: 'copy', assertable: false, subtype: 'term', length: 18 },
      ],
    });
    expect(withCopy.confidence).toBeGreaterThan(alone.confidence);
    expect(withCopy.evidence).toContain('You copied a phrase from it');
  });

  it('smooth scrolling does not corroborate anything', () => {
    const clock = fixedClock();
    const alone = engineAt(clock).update({ telemetry: { type: 'backtrack', backtrackPx: 200 } });
    const withSmooth = engineAt(clock).update({
      telemetry: [
        { type: 'backtrack', backtrackPx: 200 },
        { type: 'scroll_jerk', assertable: false, subtype: 'smooth', jerk: 0.001 },
      ],
    });
    expect(withSmooth.confidence).toBe(alone.confidence);
  });

  it('does not corroborate a state the signal says nothing about', () => {
    const clock = fixedClock();
    const alone = engineAt(clock).update({
      telemetry: { type: 'regression', subtype: 'slow_return', distance: 1, latencyMs: 25000 },
    });
    const withCopy = engineAt(clock).update({
      telemetry: [
        { type: 'regression', subtype: 'slow_return', distance: 1, latencyMs: 25000 },
        { type: 'copy', assertable: false, subtype: 'term', length: 18 },
      ],
    });
    // on_pace is not in the copy rule's state list, so nothing changes.
    expect(withCopy.confidence).toBe(alone.confidence);
  });
});

describe('subscribers', () => {
  it('fires on change and not on repeats', () => {
    const e = engineAt(fixedClock());
    const seen = vi.fn();
    e.subscribe(seen);
    const t = { type: 'backtrack', backtrackPx: 200 };
    e.update({ telemetry: t });
    e.update({ telemetry: t });
    expect(seen).toHaveBeenCalledTimes(1);
    e.update({});
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls[1][0].label).toBe(STATES.UNKNOWN);
  });

  it('survives a subscriber that throws', () => {
    const e = engineAt(fixedClock());
    const good = vi.fn();
    e.subscribe(() => { throw new Error('bad subscriber'); });
    e.subscribe(good);
    expect(() => e.update({ telemetry: { type: 'backtrack', backtrackPx: 200 } })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const e = engineAt(fixedClock());
    const seen = vi.fn();
    const off = e.subscribe(seen);
    off();
    e.update({ telemetry: { type: 'backtrack', backtrackPx: 200 } });
    expect(seen).not.toHaveBeenCalled();
  });
});
