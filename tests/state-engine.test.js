import { describe, it, expect, vi } from 'vitest';
import {
  createReadingStateEngine,
  STATES,
  GAZE_LABEL_TO_STATE,
} from '../TL_DR/src/content/state-engine.js';

/* A controllable clock so nothing here depends on wall time. */
function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function engineAt(clock, options) {
  return createReadingStateEngine({ now: clock.now, options });
}

const goodGaze = (label, over = {}) => ({
  enabled: true, label, quality: 0.9, lastSampleAt: 1_000_000, ...over,
});

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
    expect(s.cameraContribution).toBe(0);
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

  it('works with the camera off, contributing nothing from gaze', () => {
    const e = engineAt(fixedClock());
    const s = e.update({
      telemetry: { type: 'backtrack', backtrackPx: 200 },
      gaze: { enabled: false },
    });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.cameraContribution).toBe(0);
  });
});

/* This block is the point of the whole module. */
describe('gaze cannot assert an actionable state on its own', () => {
  it.each([
    ['confused',   STATES.STRUGGLING],
    ['overloaded', STATES.STRUGGLING],
    ['zoning_out', STATES.DRIFTING],
    ['skimming',   STATES.SKIMMING],
    ['focused',    STATES.ON_PACE],
  ])('gaze label %s does not produce a state without telemetry', (label, wouldBe) => {
    // The translation table knows what the label means...
    expect(GAZE_LABEL_TO_STATE[label]).toBe(wouldBe);
    // ...and the engine still refuses to act on it alone.
    const e = engineAt(fixedClock());
    const s = e.update({ gaze: goodGaze(label) });
    expect(s.label).toBe(STATES.UNKNOWN);
    expect(s.confidence).toBe(0);
  });

  it('high-confidence gaze with perfect quality is still not enough', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ gaze: goodGaze('confused', { quality: 1.0 }) });
    expect(s.label).toBe(STATES.UNKNOWN);
  });
});

describe('gaze corroborates but never overrides', () => {
  it('raises confidence when it agrees with telemetry', () => {
    const clock = fixedClock();
    const withoutGaze = engineAt(clock).update({
      telemetry: { type: 'backtrack', backtrackPx: 200 },
    });
    const withGaze = engineAt(clock).update({
      telemetry: { type: 'backtrack', backtrackPx: 200 },
      gaze: goodGaze('confused'),
    });
    expect(withGaze.label).toBe(withoutGaze.label);
    expect(withGaze.confidence).toBeGreaterThan(withoutGaze.confidence);
    expect(withGaze.cameraContribution).toBeGreaterThan(0);
    expect(withGaze.evidence).toContain('Eye tracking agrees');
  });

  it('disagreeing gaze does not change the telemetry label or lower confidence', () => {
    const clock = fixedClock();
    const base = engineAt(clock).update({
      telemetry: { type: 'backtrack', backtrackPx: 200 },
    });
    const s = engineAt(clock).update({
      telemetry: { type: 'backtrack', backtrackPx: 200 },
      gaze: goodGaze('focused'),
    });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.confidence).toBe(base.confidence);
    expect(s.cameraContribution).toBe(0);
  });

  it('abstains from corroborating below the quality floor', () => {
    const clock = fixedClock();
    const s = engineAt(clock).update({
      telemetry: { type: 'backtrack', backtrackPx: 200 },
      gaze: goodGaze('confused', { quality: 0.3 }),
    });
    expect(s.cameraContribution).toBe(0);
    expect(s.evidence).not.toContain('Eye tracking agrees');
  });
});

describe('presence', () => {
  it('reports absent when samples go stale', () => {
    const clock = fixedClock();
    const e = engineAt(clock);
    clock.advance(10_000);
    const s = e.update({ gaze: { enabled: true, label: 'focused', quality: 0.9, lastSampleAt: 1_000_000 } });
    expect(s.label).toBe(STATES.ABSENT);
    expect(s.cameraContribution).toBe(1);
  });
});

describe('idle disambiguation — the one place the camera changes an answer', () => {
  const idle = { pageFocused: true, msSinceInput: 60_000, expectedMs: 20_000 };

  it('idle plus a present reader is drifting', () => {
    const s = engineAt(fixedClock()).update({ idle, gaze: goodGaze('zoning_out') });
    expect(s.label).toBe(STATES.DRIFTING);
    expect(s.cameraContribution).toBeGreaterThan(0);
  });

  it('idle plus no one there is absent', () => {
    const clock = fixedClock();
    const e = engineAt(clock);
    clock.advance(10_000);
    const s = e.update({ idle, gaze: { enabled: true, quality: 0.9, lastSampleAt: 1_000_000 } });
    expect(s.label).toBe(STATES.ABSENT);
  });

  it('idle with the camera off stays unknown rather than guessing', () => {
    const s = engineAt(fixedClock()).update({ idle, gaze: { enabled: false } });
    expect(s.label).toBe(STATES.UNKNOWN);
    expect(s.confidence).toBe(0);
  });

  it('does not fire while the reader is still within expected reading time', () => {
    const s = engineAt(fixedClock()).update({
      idle: { pageFocused: true, msSinceInput: 5_000, expectedMs: 20_000 },
      gaze: goodGaze('focused'),
    });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('ignores idle on an unfocused tab', () => {
    const s = engineAt(fixedClock()).update({
      idle: { ...idle, pageFocused: false },
      gaze: goodGaze('focused'),
    });
    expect(s.label).toBe(STATES.UNKNOWN);
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
