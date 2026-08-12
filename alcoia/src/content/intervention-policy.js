/* intervention-policy.js — decides whether a reading state earns an interruption
 *
 * The engine says what it observed. This says whether to act on it. Splitting
 * the two matters: it means the budget is enforced in one place instead of
 * being spread across a classifier loop and a scroll handler that never knew
 * about each other.
 *
 * Rules are from the project notes and are not tunable at runtime:
 *   - at most one interruption per 3 minutes
 *   - at most five per session
 *   - never twice on the same paragraph
 *   - never on `unknown`
 *
 * A wrong interruption costs more than a missed one. When in doubt, decline.
 */

import { STATES } from './state-engine.js';

/* What each state earns, when it earns anything at all.
 *
 * `ask` is a retrieval question about the passage. It is the primary
 * intervention, not a summary: summarising removes the desirable difficulty
 * that produces retention, and an answer is the only thing in this system that
 * produces ground truth. Explanation is the fallback after a wrong answer, and
 * the renderer also falls back to it when no question can be generated for a
 * passage — see `handleAsk` in content.js. */
export const STATE_ACTIONS = Object.freeze({
  [STATES.STRUGGLING]: 'ask',
  [STATES.DRIFTING]:   'nudge',
  [STATES.SKIMMING]:   'ask',
  [STATES.ON_PACE]:    'none',
  [STATES.ABSENT]:     'none',
  [STATES.UNKNOWN]:    'none',
});

export const DEFAULT_BUDGET = Object.freeze({
  minGapMs:          180000,  // 3 minutes
  maxPerSession:     5,
  minConfidence:     0.5,
  // Skimming is usually deliberate and interrupting it is obnoxious. The one
  // case worth acting on is speed through genuinely dense text, which is what
  // comprehension-monitor already gates its too_fast signal on.
  skimmingGrades:    ['difficult', 'very_difficult'],
});

/* Every label collected so far comes from a paragraph the state machine
 * already flagged, so a model trained on it can only learn to reproduce
 * today's thresholds — including their errors. Asking anyway on a slice of
 * paragraphs the detector would have left alone is the only way to collect
 * labels that are not conditioned on the detector's own decision, and data
 * collected before this exists is permanently unusable for that purpose.
 *
 * 10-15%: high enough that a session produces a usable number of exploration
 * labels, low enough that it doesn't turn the product into a quiz app for
 * readers who are doing fine. 0.125 is the midpoint of that band. */
export const EXPLORATION_SAMPLE_RATE = 0.125;

function paragraphKey(state, fallbackEl) {
  const el = (state.signal && state.signal.el) || fallbackEl || null;
  const text = (state.signal && state.signal.text) ||
               (el && (el.innerText || el.textContent)) || '';
  return text.trim().slice(0, 80) || null;
}

export function createInterventionPolicy(config = {}) {
  const budget         = { ...DEFAULT_BUDGET, ...(config.budget || {}) };
  const now            = config.now || (() => Date.now());
  // Injectable so the sampling rate is assertable under a deterministic RNG.
  const random         = config.random || Math.random;
  const explorationRate = config.explorationRate ?? EXPLORATION_SAMPLE_RATE;

  let lastAt = 0;
  let count  = 0;
  const seenParagraphs = new Set();

  /* Returns { allow, action, reason, evidence, paragraphKey, wasExplorationSample }.
   * `reason` is always populated, including on refusal — it is the only way
   * to debug why an interruption did or didn't happen. */
  function evaluate(state, ctx = {}) {
    const deny = (reason) =>
      ({ allow: false, action: 'none', reason, evidence: [], paragraphKey: null, wasExplorationSample: false });

    if (!state || !state.label) return deny('no state');
    if (state.label === STATES.UNKNOWN) return deny('state is unknown');

    let action = STATE_ACTIONS[state.label] || 'none';
    let wasExplorationSample = false;

    if (action === 'none') {
      /* Exploration bypasses only this test — the state-to-action table —
       * never the checks below it. Drifting and absent readers are excluded
       * outright: neither is reading the paragraph in front of them, and
       * invariant 8 forbids testing someone who did not read, regardless of
       * what exploration wants to learn. */
      const explorationEligible = state.label !== STATES.DRIFTING && state.label !== STATES.ABSENT;
      if (explorationEligible && random() < explorationRate) {
        action = 'ask';
        wasExplorationSample = true;
      } else {
        return deny(`no action for ${state.label}`);
      }
    }

    if (state.confidence < budget.minConfidence) {
      return deny(`confidence ${state.confidence.toFixed(2)} below ${budget.minConfidence}`);
    }

    if (state.label === STATES.SKIMMING) {
      const grade = state.signal && state.signal.readability && state.signal.readability.grade;
      if (!budget.skimmingGrades.includes(grade)) {
        return deny('skimming, but the text is not dense enough to interrupt over');
      }
    }

    if (count >= budget.maxPerSession) {
      return deny(`session budget spent (${count}/${budget.maxPerSession})`);
    }

    const since = now() - lastAt;
    if (lastAt !== 0 && since < budget.minGapMs) {
      return deny(`only ${Math.round(since / 1000)}s since the last interruption`);
    }

    const key = paragraphKey(state, ctx.currentEl);
    if (key && seenParagraphs.has(key)) {
      return deny('already interrupted on this paragraph');
    }

    return {
      allow: true,
      action,
      reason: wasExplorationSample
        ? `exploration sample on ${state.label}`
        : `${state.label} at ${state.confidence.toFixed(2)}`,
      // Evidence goes in front of the reader. An interruption that cannot say
      // what it noticed should not be shown.
      evidence: state.evidence || [],
      paragraphKey: key,
      wasExplorationSample,
    };
  }

  /* Call only once an interruption is actually on screen. Keeping this
   * separate from evaluate() means a decision that gets dropped downstream
   * doesn't silently consume the budget. */
  function record(decision) {
    if (!decision || !decision.allow) return;
    lastAt = now();
    count += 1;
    if (decision.paragraphKey) seenParagraphs.add(decision.paragraphKey);
  }

  return {
    evaluate,
    record,
    stats: () => ({ count, lastAt, remaining: Math.max(0, budget.maxPerSession - count) }),
    reset() { lastAt = 0; count = 0; seenParagraphs.clear(); },
  };
}
