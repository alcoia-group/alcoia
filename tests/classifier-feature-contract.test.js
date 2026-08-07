/* The guard the project notes asked for, as a contract rather than a memory.
 *
 * THE TRAP: classifier.js is a generated tree of `<=` comparisons, and
 * `undefined <= 30` is false rather than an error. Remove a feature from the
 * extractor without regenerating the tree and nothing crashes — the classifier
 * routes down one branch forever and keeps emitting confident labels. The
 * browser check would still print plausible states, because printing plausible
 * states IS the failure mode.
 *
 * So no test that merely runs the classifier can catch this. This one reads
 * both files and compares the set the tree branches on against the set the
 * extractor actually emits. Delete a feature and this fails immediately, with
 * the name of the feature, before anything reaches a reader.
 *
 * If you are here because this test is failing: you removed a key from the
 * extractor. Retrain in `tldr classifier/tldr_classifier_training(1).ipynb`
 * against the reduced feature set, regenerate classifier.js, and only then
 * change the extractor. Do not "fix" this test by deleting the assertion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyGazeState } from '../alcoia/src/content/classifier.js';

const CLASSIFIER = 'alcoia/src/content/classifier.js';
const EXTRACTOR  = 'alcoia/src/content/gaze-features.js';

/* Every `f.<key>` the generated tree reads. */
function branchKeys() {
  const src = readFileSync(CLASSIFIER, 'utf8');
  return new Set([...src.matchAll(/\bf\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
}

/* Every key in the object computeFeatures() returns. */
function emittedKeys() {
  const src = readFileSync(EXTRACTOR, 'utf8');
  const fnAt = src.indexOf('function computeFeatures');
  expect(fnAt, 'computeFeatures not found — this test needs updating').toBeGreaterThan(-1);
  const start = src.indexOf('return {', fnAt);
  const end = src.indexOf('};', start);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]));
}

describe('classifier / extractor feature contract', () => {
  it('the extractor supplies every feature the tree branches on', () => {
    const branches = branchKeys();
    const emitted = emittedKeys();
    const missing = [...branches].filter((k) => !emitted.has(k));

    expect(missing, `classifier.js branches on ${missing.join(', ')} but computeFeatures() no longer emits them. `
      + 'Every comparison against these is `undefined <= x`, which is false and does not throw, so the tree '
      + 'will route down one branch and keep returning confident labels. Retrain and regenerate before removing '
      + 'features from the extractor.').toEqual([]);
  });

  it('branches on the nine features the header documents, and no more', () => {
    // Pins the tree's input surface. A regenerated tree with a different
    // feature set should fail here and be reviewed deliberately.
    expect([...branchKeys()].sort()).toEqual([
      'avg_fixation_ms', 'fixation_std', 'gaze_drift_px', 'line_reread_count',
      'regression_rate', 'saccade_length', 'saccade_std', 'scroll_delta_px',
      'velocity_mean',
    ]);
  });

  it('the P2 presence additions are extra, not substitutes', () => {
    const emitted = emittedKeys();
    // These were added for the state engine, which is the only consumer that
    // should be trusting gaze. They must not have displaced anything.
    expect(emitted.has('on_page_fraction')).toBe(true);
    expect(emitted.has('face_present')).toBe(true);
    expect(emitted.has('gaze_quality')).toBe(true);
  });

  /* Demonstrates why the file comparison above is the real guard: running the
   * classifier proves nothing, because the broken case looks fine. */
  it('cannot be caught by running the classifier — the failure is silent', () => {
    const full = {
      avg_fixation_ms: 220, fixation_std: 50, regression_rate: 0.1,
      saccade_length: 80, saccade_std: 30, gaze_drift_px: 20,
      scroll_delta_px: 40, velocity_mean: 180, line_reread_count: 1,
    };
    const { saccade_length: _a, saccade_std: _b, velocity_mean: _c, ...reduced } = full;

    // Both return a confident label. Nothing here distinguishes them.
    expect(classifyGazeState(full).label).toBeTruthy();
    expect(classifyGazeState(reduced).label).toBeTruthy();
    expect(classifyGazeState(reduced).confidence).toBeGreaterThan(0.5);
    // ...and yet they disagree, which is the whole problem.
    expect(classifyGazeState(reduced).label).not.toBe(classifyGazeState(full).label);
  });
});
