/* Invariant 9: "Every failure degrades to silence... every one resolves to
 * unknown, and unknown never interrupts. A wrong intervention is worse than
 * a missed one." Stated in the project notes, previously unguarded by any test.
 *
 * This file covers the failure paths that live in exported, importable
 * modules: question-card.js's defence against malformed question shapes,
 * and state-engine.js's resolution of unrecognised or absent telemetry to
 * `unknown`. Two of the paths in this item's brief cannot be unit-tested
 * this way and are covered elsewhere instead:
 *
 *   - Server unreachable / 422 / malformed response from the questions
 *     endpoint, and PDF/PPTX extraction failure: both live inside
 *     content.js's handleAsk() and triggerAIForParagraph(), which are not
 *     exported — content.js is a single non-modular IIFE, not an ES module.
 *     tests/browser/smoke.mjs's `FAIL=questions` mode exercises the real
 *     network-failure path end to end instead: the mock server returns a
 *     422 for every /api/questions call, and the run asserts the endpoint
 *     was actually hit, no question card ever reached the screen, and no
 *     page error was thrown. PDF/PPTX extraction failure is now wrapped in
 *     try/catch in content.js (falls through to the existing empty-text
 *     return), but verifying the PDF/PPTX pipeline itself is item 20's
 *     dedicated audit, not this one's.
 *   - Missing or invalid install token: there is no token mechanism in the
 *     client yet (see item 9 in the build brief). Nothing to test here
 *     until it lands.
 *   - Storage read failure: chrome.storage.local.get's callback contract
 *     always receives an object, even on error (chrome.runtime.lastError is
 *     set separately) — so `chrome.storage.local.get(DEFAULTS, cb)` already
 *     degrades to the supplied defaults by construction, not by any code in
 *     this repository that could be unit-tested in isolation.
 *
 * Also confirms decisions dropped downstream never spend the interruption
 * budget, which is the other half of "degrades to silence" — a failure that
 * silently burned one of the reader's handful of interruptions would be its
 * own defect.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReadingStateEngine, STATES } from '../alcoia/src/content/state-engine.js';
import { createInterventionPolicy } from '../alcoia/src/content/intervention-policy.js';
import { createQuestionCard } from '../alcoia/src/content/question-card.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const GOOD_QUESTION = {
  q: 'What did the passage say?',
  options: ['Real but weak', 'Strong', 'Absent', 'Exact'],
  answerIndex: 0,
  explanation: 'The passage says real but weak.',
  span: 'The relationship is real but weak.',
};

function fakeDeps(overrides = {}) {
  const reservePopup = vi.fn(() => ({
    querySelector: () => ({ onclick: null }),
    querySelectorAll: () => [],
  }));
  return {
    ui: { reservePopup, showPopup: vi.fn(), closePopup: vi.fn(), ...overrides.ui },
    esc: (s) => String(s),
    responseSignals: { present: vi.fn(), ...overrides.responseSignals },
    fetchExplanation: async () => '',
    onAnswered: vi.fn(),
    onDismissed: vi.fn(),
    _reservePopup: reservePopup,
  };
}

describe('question-card.js: malformed question shapes degrade to silence', () => {
  it('shows a well-formed question — the control case', () => {
    const deps = fakeDeps();
    const card = createQuestionCard(deps);
    expect(card.show(GOOD_QUESTION)).toBe(true);
    expect(deps._reservePopup).toHaveBeenCalled();
  });

  it.each([
    ['null question', null],
    ['missing q', { ...GOOD_QUESTION, q: undefined }],
    ['blank q', { ...GOOD_QUESTION, q: '   ' }],
    ['options not an array', { ...GOOD_QUESTION, options: 'four options' }],
    ['three options instead of four', { ...GOOD_QUESTION, options: GOOD_QUESTION.options.slice(0, 3) }],
    ['five options instead of four', { ...GOOD_QUESTION, options: [...GOOD_QUESTION.options, 'Extra'] }],
    ['a non-string option', { ...GOOD_QUESTION, options: [GOOD_QUESTION.options[0], null, GOOD_QUESTION.options[2], GOOD_QUESTION.options[3]] }],
    ['a blank option', { ...GOOD_QUESTION, options: [GOOD_QUESTION.options[0], '  ', GOOD_QUESTION.options[2], GOOD_QUESTION.options[3]] }],
    ['answerIndex missing', { ...GOOD_QUESTION, answerIndex: undefined }],
    ['answerIndex out of range', { ...GOOD_QUESTION, answerIndex: 4 }],
    ['answerIndex negative', { ...GOOD_QUESTION, answerIndex: -1 }],
    ['answerIndex not an integer', { ...GOOD_QUESTION, answerIndex: 1.5 }],
    ['both q and span missing — the uncaught-exception case', { ...GOOD_QUESTION, q: undefined, span: undefined }],
  ])('%s: returns false, no popup reserved, no response-signal presented', (_label, malformed) => {
    const deps = fakeDeps();
    const card = createQuestionCard(deps);
    expect(() => card.show(malformed)).not.toThrow();
    expect(card.show(malformed)).toBe(false);
    expect(deps._reservePopup).not.toHaveBeenCalled();
    expect(deps.responseSignals.present).not.toHaveBeenCalled();
  });
});

describe('state-engine.js: unrecognised or absent telemetry resolves to unknown', () => {
  it('an unrecognised signal type asserts nothing', () => {
    const e = createReadingStateEngine({ now: fixedClock().now });
    const s = e.update({ telemetry: { type: 'nonsense_from_a_future_detector', payload: '???' } });
    expect(s.label).toBe(STATES.UNKNOWN);
    expect(s.confidence).toBe(0);
  });

  it('a telemetry object with no type asserts nothing', () => {
    const e = createReadingStateEngine({ now: fixedClock().now });
    const s = e.update({ telemetry: { subtype: 'too_slow' } });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('a null telemetry entry in a batch is ignored rather than throwing', () => {
    const e = createReadingStateEngine({ now: fixedClock().now });
    expect(() => e.update({ telemetry: [null, undefined, { type: 'backtrack', backtrackPx: 200 }] }))
      .not.toThrow();
    const s = e.getState();
    expect(s.label).toBe(STATES.STRUGGLING);
  });

  it('an empty update produces unknown, never a stale previous state read as fresh', () => {
    const e = createReadingStateEngine({ now: fixedClock().now });
    e.update({ telemetry: { type: 'backtrack', backtrackPx: 200 } });
    const s = e.update({});
    expect(s.label).toBe(STATES.UNKNOWN);
    expect(s.confidence).toBe(0);
  });
});

describe('a decision that never reaches the screen does not spend the budget', () => {
  it('evaluate() without a matching record() leaves the budget untouched', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });
    // Mirrors what content.js's onIntervention does on failure: evaluate()
    // allows it, but the caller never calls record() because nothing
    // actually reached the screen.
    const d = p.evaluate({
      label: STATES.STRUGGLING, confidence: 0.7, evidence: [], signal: { text: 'p' },
    });
    expect(d.allow).toBe(true);
    expect(p.stats().count).toBe(0);

    // The 3-minute gap is therefore still open — a dropped decision must
    // not have silently consumed it.
    clock.advance(1000);
    const again = p.evaluate({
      label: STATES.STRUGGLING, confidence: 0.7, evidence: [], signal: { text: 'p' },
    });
    expect(again.allow).toBe(true);
  });

  it('record() is a no-op for a decision that was denied', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const denied = p.evaluate({ label: STATES.UNKNOWN, confidence: 0, evidence: [] });
    expect(denied.allow).toBe(false);
    p.record(denied);
    expect(p.stats().count).toBe(0);
  });
});
