import { describe, it, expect, vi } from 'vitest';
import { createReadingStateEngine, STATES, SUBSTATES, SELF_REPORT } from '../alcoia/src/content/state-engine.js';

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

  /* An unregistered signal type is silently ignored — see Conventions in
   * CLAUDE.md, and how cursor_reading died: listed in CORROBORATING_TYPES
   * with no matching CORROBORATION entry, so it was excluded from asserting
   * but never actually applied either. Registering a type is a deliberate
   * two-place decision (fromSignal() for assertable types, or both
   * CORROBORATING_TYPES and CORROBORATION for corroboration-only ones), not
   * something that happens by adding it to one list. */
  it('ignores a signal type nothing has registered', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'cursor_reading', tracking: true } });
    expect(s.label).toBe(STATES.UNKNOWN);
    expect(s.evidence).toEqual([]);
  });
});

describe('a reading signal drives the state', () => {
  it('too_slow becomes struggling and says why in the reader\'s terms', () => {
    const e = engineAt(fixedClock());
    const s = e.update({
      reading: {
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
      reading: {
        type: 'speed_mismatch', subtype: 'too_fast',
        readability: { grade: 'difficult' },
      },
    });
    expect(s.label).toBe(STATES.SKIMMING);
    expect(s.evidence[0]).toMatch(/dense paragraph quickly/);
  });

  it('backtrack becomes struggling and reports the distance', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'backtrack', backtrackPx: 240 } });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.evidence[0]).toMatch(/scrolled back 240px/);
  });
});

describe('P2 reading signals', () => {
  it('a fast return is struggling and outranks an ordinary one', () => {
    const fast = engineAt(fixedClock()).update({
      reading: { type: 'regression', subtype: 'fast_return', distance: 2, latencyMs: 1200 },
    });
    const ordinary = engineAt(fixedClock()).update({
      reading: { type: 'regression', subtype: 'return', distance: 2, latencyMs: 5000 },
    });
    expect(fast.label).toBe(STATES.STRUGGLING);
    expect(ordinary.label).toBe(STATES.STRUGGLING);
    expect(fast.confidence).toBeGreaterThan(ordinary.confidence);
    expect(fast.evidence[0]).toMatch(/jumped straight back 2 paragraphs/);
  });

  it('a slow return is competent reading, not struggling', () => {
    const s = engineAt(fixedClock()).update({
      reading: { type: 'regression', subtype: 'slow_return', distance: 1, latencyMs: 25000 },
    });
    expect(s.label).toBe(STATES.ON_PACE);
    expect(s.evidence[0]).toMatch(/went back a paragraph to review/);
  });

  it('returning to the same paragraph after a long absence is struggling', () => {
    const s = engineAt(fixedClock()).update({
      reading: { type: 'blur_return', subtype: 'resumed_same', blurMs: 180_000, paragraphIndex: 3 },
    });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.evidence[0]).toMatch(/after 3 minutes away/);
  });

  it('takes the strongest assertion when several arrive together', () => {
    const s = engineAt(fixedClock()).update({
      reading: [
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
    const s = engineAt(fixedClock()).update({ reading: sig });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('a copy alongside a struggling signal raises confidence and is reported', () => {
    const clock = fixedClock();
    const alone = engineAt(clock).update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    const withCopy = engineAt(clock).update({
      reading: [
        { type: 'backtrack', backtrackPx: 200 },
        { type: 'copy', assertable: false, subtype: 'term', length: 18 },
      ],
    });
    expect(withCopy.confidence).toBeGreaterThan(alone.confidence);
    expect(withCopy.evidence).toContain('You copied a phrase from it');
  });

  it('smooth scrolling does not corroborate anything', () => {
    const clock = fixedClock();
    const alone = engineAt(clock).update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    const withSmooth = engineAt(clock).update({
      reading: [
        { type: 'backtrack', backtrackPx: 200 },
        { type: 'scroll_jerk', assertable: false, subtype: 'smooth', jerk: 0.001 },
      ],
    });
    expect(withSmooth.confidence).toBe(alone.confidence);
  });

  it('does not corroborate a state the signal says nothing about', () => {
    const clock = fixedClock();
    const alone = engineAt(clock).update({
      reading: { type: 'regression', subtype: 'slow_return', distance: 1, latencyMs: 25000 },
    });
    const withCopy = engineAt(clock).update({
      reading: [
        { type: 'regression', subtype: 'slow_return', distance: 1, latencyMs: 25000 },
        { type: 'copy', assertable: false, subtype: 'term', length: 18 },
      ],
    });
    // on_pace is not in the copy rule's state list, so nothing changes.
    expect(withCopy.confidence).toBe(alone.confidence);
  });
});

/* Item 43: grading authority degrades by level. A model verdict must never
 * carry the same confidence as a deterministic one — checked here at the
 * one place that number is actually decided, not just assumed from the
 * signal's own fields. */
describe('grading-method-aware confidence (item 43)', () => {
  it('a model-graded correct verdict at free_recall carries less confidence than a deterministic one', () => {
    const deterministic = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'correct', correct: true, gradingMethod: 'deterministic', level: 'recognition' },
    });
    const modelGraded = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'correct', correct: true, gradingMethod: 'model', level: 'free_recall' },
    });
    expect(modelGraded.label).toBe(STATES.ON_PACE);
    expect(modelGraded.confidence).toBeLessThan(deterministic.confidence);
  });

  it('a model-graded incorrect verdict at free_recall carries less confidence than a deterministic one', () => {
    const deterministic = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'incorrect', correct: false, gradingMethod: 'deterministic', level: 'recognition' },
    });
    const modelGraded = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'incorrect', correct: false, gradingMethod: 'model', level: 'free_recall' },
    });
    expect(modelGraded.label).toBe(STATES.STRUGGLING);
    expect(modelGraded.confidence).toBeLessThan(deterministic.confidence);
  });

  it('scenario carries the lowest confidence of any level that can assert on_pace', () => {
    const freeRecall = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'correct', correct: true, gradingMethod: 'model', level: 'free_recall' },
    });
    const scenario = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'correct', correct: true, gradingMethod: 'model', level: 'scenario' },
    });
    expect(scenario.confidence).toBeLessThan(freeRecall.confidence);
  });

  // The core safety property this item exists for: a false "you are wrong"
  // at scenario is worse than a missed correction, and unrecoverable — the
  // reader stops trusting the system. This must hold even if the record
  // arrives with subtype 'incorrect' (i.e. even if whatever produced it
  // failed to uphold the "never assert wrong" rule upstream).
  it('never asserts struggling from a scenario-level "incorrect" signal, no matter how it arrived', () => {
    const s = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'incorrect', correct: false, gradingMethod: 'model', level: 'scenario' },
    });
    expect(s.label).toBe(STATES.UNKNOWN);
    expect(s.confidence).toBe(0);
  });

  it('an unknown grading verdict asserts nothing, the same as a dismissal', () => {
    const s = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'unknown', correct: null, gradingMethod: 'model', level: 'scenario' },
    });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('an adversarial (ungraded) response asserts nothing about comprehension', () => {
    const s = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'ungraded', correct: null, gradingMethod: 'none', level: 'adversarial' },
    });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('a response signal with no gradingMethod at all is treated as deterministic — every record made before this item looked like that', () => {
    const legacy = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'correct', correct: true },
    });
    const deterministic = engineAt(fixedClock()).update({
      reading: { type: 'response', subtype: 'correct', correct: true, gradingMethod: 'deterministic', level: 'recognition' },
    });
    expect(legacy.confidence).toBe(deterministic.confidence);
  });
});

describe('subscribers', () => {
  it('fires on change and not on repeats', () => {
    const e = engineAt(fixedClock());
    const seen = vi.fn();
    e.subscribe(seen);
    const t = { type: 'backtrack', backtrackPx: 200 };
    e.update({ reading: t });
    e.update({ reading: t });
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
    expect(() => e.update({ reading: { type: 'backtrack', backtrackPx: 200 } })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const e = engineAt(fixedClock());
    const seen = vi.fn();
    const off = e.subscribe(seen);
    off();
    e.update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    expect(seen).not.toHaveBeenCalled();
  });
});

/* Item 13a: struggling is not one thing — a substate the intervention
 * layer can read, additive alongside the unchanged top-level `label`. */
describe('substate — additive, struggling-only', () => {
  it('is null when the state is unknown (nothing given)', () => {
    const e = engineAt(fixedClock());
    expect(e.update({}).substate).toBeNull();
  });

  it('is null for on_pace (correct response)', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'response', subtype: 'correct' } });
    expect(s.label).toBe(STATES.ON_PACE);
    expect(s.substate).toBeNull();
  });

  it('is null for skimming (too_fast)', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'speed_mismatch', subtype: 'too_fast', readability: { grade: 'difficult' } } });
    expect(s.label).toBe(STATES.SKIMMING);
    expect(s.substate).toBeNull();
  });

  it('is null for drifting-shaped input (no assertable signal at all)', () => {
    // state-engine.js itself never asserts DRIFTING from an ordinary
    // reading signal (that mapping lives in intervention-policy.js /
    // orchestrator.js's idle handling) — the only path that reaches
    // DRIFTING here is a self-report, covered in its own describe block
    // below. This just confirms the unknown/no-proposal path stays null.
    const e = engineAt(fixedClock());
    expect(e.update({ reading: { type: 'idle' } }).substate).toBeNull();
  });

  it('is null for every ordinary struggle-adjacent signal type EXCEPT struggling itself — regression guard against a future signal accidentally reaching skimming/on_pace with a substate attached', () => {
    const e = engineAt(fixedClock());
    const slowReturn = e.update({ reading: { type: 'regression', subtype: 'slow_return', distance: 1 } });
    expect(slowReturn.label).toBe(STATES.ON_PACE);
    expect(slowReturn.substate).toBeNull();
  });

  it("is 'unclear' for an ordinary struggling signal — no dedicated confusion/overload signal exists yet (items 13b/13c/13d)", () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.substate).toBe(SUBSTATES.UNCLEAR);
  });

  it("is 'unclear' for every struggling-asserting signal type, not just one", () => {
    const e = engineAt(fixedClock());
    const cases = [
      { type: 'speed_mismatch', subtype: 'too_slow', actualWpm: 90, baselineWpm: 225, readability: { grade: 'standard' } },
      { type: 'regression', subtype: 'fast_return', distance: 1 },
      { type: 'blur_return', blurMs: 30000 },
      { type: 'response', subtype: 'incorrect' },
    ];
    for (const reading of cases) {
      const s = e.update({ reading });
      expect(s.label).toBe(STATES.STRUGGLING);
      expect(s.substate).toBe(SUBSTATES.UNCLEAR);
    }
  });
});

describe('self-report (item 13a) — the highest-confidence evidence, overrides any inferred substate immediately', () => {
  it('confusion sets label struggling and substate confusion', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'self_report', subtype: SELF_REPORT.CONFUSION } });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.substate).toBe(SUBSTATES.CONFUSION);
    expect(s.confidence).toBe(1);
  });

  it('overload sets label struggling and substate overload', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'self_report', subtype: SELF_REPORT.OVERLOAD } });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.substate).toBe(SUBSTATES.OVERLOAD);
  });

  it('disengaged resolves to the EXISTING top-level DRIFTING state, not a fourth substate value', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'self_report', subtype: SELF_REPORT.DISENGAGED } });
    expect(s.label).toBe(STATES.DRIFTING);
    expect(s.substate).toBeNull();
  });

  it('an unrecognised self_report subtype asserts nothing, same as any other unregistered signal', () => {
    const e = engineAt(fixedClock());
    const s = e.update({ reading: { type: 'self_report', subtype: 'bogus' } });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('immediately overrides an already-inferred unclear substate — the exact override this task requires', () => {
    const e = engineAt(fixedClock());
    const inferred = e.update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    expect(inferred.substate).toBe(SUBSTATES.UNCLEAR);

    const reported = e.update({ reading: { type: 'self_report', subtype: SELF_REPORT.CONFUSION } });
    expect(reported.substate).toBe(SUBSTATES.CONFUSION);
  });

  it('wins strongestAssertion() even against a wrong-answer response batched in the SAME update() call — the highest-confidence evidence, full stop', () => {
    const e = engineAt(fixedClock());
    const s = e.update({
      reading: [
        { type: 'response', subtype: 'incorrect' }, // confidence 0.95 — the previous ceiling
        { type: 'self_report', subtype: SELF_REPORT.OVERLOAD },
      ],
    });
    expect(s.label).toBe(STATES.STRUGGLING);
    expect(s.substate).toBe(SUBSTATES.OVERLOAD);
  });

  it('a self-report emits even when label/confidence are unchanged from the current state — substate alone must trigger a real emission, not just label/confidence', () => {
    const e = engineAt(fixedClock());
    e.update({ reading: { type: 'self_report', subtype: SELF_REPORT.CONFUSION } }); // struggling/confusion, confidence 1
    const seen = vi.fn();
    e.subscribe(seen);

    // Same label (struggling), same confidence (1) — only substate differs.
    e.update({ reading: { type: 'self_report', subtype: SELF_REPORT.OVERLOAD } });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].substate).toBe(SUBSTATES.OVERLOAD);
  });

  it('getState() reflects the self-reported substate after the fact, same as any other field', () => {
    const e = engineAt(fixedClock());
    e.update({ reading: { type: 'self_report', subtype: SELF_REPORT.CONFUSION } });
    expect(e.getState().substate).toBe(SUBSTATES.CONFUSION);
    expect(e.getState().label).toBe(STATES.STRUGGLING);
  });
});
