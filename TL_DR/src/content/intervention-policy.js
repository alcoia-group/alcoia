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
 * P3 replaces `explain` with `ask` — a retrieval question, with explanation
 * demoted to the fallback after a wrong answer. Until the question endpoint
 * exists, `explain` is what we have. Do not read this table as a decision
 * that summarising is the right intervention; it isn't. */
export const STATE_ACTIONS = Object.freeze({
  [STATES.STRUGGLING]: 'explain',
  [STATES.DRIFTING]:   'nudge',
  [STATES.SKIMMING]:   'explain',
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

function paragraphKey(state, fallbackEl) {
  const el = (state.signal && state.signal.el) || fallbackEl || null;
  const text = (state.signal && state.signal.text) ||
               (el && (el.innerText || el.textContent)) || '';
  return text.trim().slice(0, 80) || null;
}

export function createInterventionPolicy(config = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(config.budget || {}) };
  const now    = config.now || (() => Date.now());

  let lastAt = 0;
  let count  = 0;
  const seenParagraphs = new Set();

  /* Returns { allow, action, reason, evidence, paragraphKey }.
   * `reason` is always populated, including on refusal — it is the only way
   * to debug why an interruption did or didn't happen. */
  function evaluate(state, ctx = {}) {
    const deny = (reason) => ({ allow: false, action: 'none', reason, evidence: [], paragraphKey: null });

    if (!state || !state.label) return deny('no state');
    if (state.label === STATES.UNKNOWN) return deny('state is unknown');

    const action = STATE_ACTIONS[state.label] || 'none';
    if (action === 'none') return deny(`no action for ${state.label}`);

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
      reason: `${state.label} at ${state.confidence.toFixed(2)}`,
      // Evidence goes in front of the reader. An interruption that cannot say
      // what it noticed should not be shown.
      evidence: state.evidence || [],
      paragraphKey: key,
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
