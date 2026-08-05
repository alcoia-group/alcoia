/* The failure mode the project notes calls THE TRAP.
 *
 * classifier.js is a generated decision tree of `<=` comparisons. In JS,
 * `undefined <= 30` is false rather than an error, so a feature object with
 * missing keys does not crash the classifier — it routes down one branch and
 * returns a confident-looking label forever.
 *
 * These are characterization tests. They pin the CURRENT, DANGEROUS behaviour
 * so that it cannot change silently. If someone adds the throwing guard that
 * the project notes asks for, the first block fails — that is the intended signal, not
 * a regression. Update it deliberately at that point.
 */
import { describe, it, expect } from 'vitest';
import { classifyGazeState } from '../TL_DR/src/content/classifier.js';
import { createReadingStateEngine, STATES } from '../TL_DR/src/content/state-engine.js';

const FEATURES = [
  'avg_fixation_ms', 'fixation_std', 'regression_rate',
  'saccade_length', 'saccade_std', 'gaze_drift_px',
  'scroll_delta_px', 'velocity_mean', 'line_reread_count',
];

const focusedSample = {
  avg_fixation_ms: 220, fixation_std: 50, regression_rate: 0.1,
  saccade_length: 80, saccade_std: 30, gaze_drift_px: 20,
  scroll_delta_px: 40, velocity_mean: 180, line_reread_count: 1,
};

describe('THE TRAP — missing features do not throw', () => {
  it('classifies a complete feature vector', () => {
    const r = classifyGazeState(focusedSample);
    expect(r.label).toBe('focused');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('returns a confident label for an EMPTY object instead of failing', () => {
    const r = classifyGazeState({});
    expect(r).toHaveProperty('label');
    expect(r.confidence).toBeGreaterThan(0);
    // No data whatsoever, and it still commits to a state.
    expect(r.label).toBe('skimming');
  });

  it('silently flips the label when the saccade/velocity keys are dropped', () => {
    const { saccade_length, saccade_std, velocity_mean, ...reduced } = focusedSample;
    const full = classifyGazeState(focusedSample);
    const partial = classifyGazeState(reduced);

    expect(full.label).toBe('focused');
    expect(partial.label).toBe('skimming');
    expect(partial.confidence).toBeGreaterThanOrEqual(full.confidence);
  });

  it.each(FEATURES)('dropping %s alone still yields a label, never an error', (key) => {
    const reduced = { ...focusedSample };
    delete reduced[key];
    expect(() => classifyGazeState(reduced)).not.toThrow();
    expect(classifyGazeState(reduced).label).toBeTruthy();
  });
});

/* The mitigation P1 actually delivers. The trap is not fixed — it is contained,
 * because a gaze label no longer reaches the reader on its own. */
describe('the state engine contains the trap', () => {
  it('a garbage-derived gaze label cannot produce an actionable state', () => {
    const bogus = classifyGazeState({});
    expect(bogus.label).toBeTruthy();

    const engine = createReadingStateEngine();
    const state = engine.update({
      gaze: { enabled: true, label: bogus.label, quality: 1.0, lastSampleAt: Date.now() },
    });

    expect(state.label).toBe(STATES.UNKNOWN);
    expect(state.confidence).toBe(0);
  });

  it('a bogus confused label cannot manufacture a struggling state', () => {
    const engine = createReadingStateEngine();
    const state = engine.update({
      gaze: { enabled: true, label: 'confused', quality: 1.0, lastSampleAt: Date.now() },
    });
    expect(state.label).not.toBe(STATES.STRUGGLING);
    expect(state.label).toBe(STATES.UNKNOWN);
  });
});
