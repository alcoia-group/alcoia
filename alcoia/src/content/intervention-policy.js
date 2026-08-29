/* intervention-policy.js — decides whether a reading state earns an interruption
 *
 * The engine says what it observed. This says whether to act on it. Splitting
 * the two matters: it means the budget is enforced in one place instead of
 * being spread across a classifier loop and a scroll handler that never knew
 * about each other.
 *
 * Rules are from CLAUDE.md and are not tunable at runtime:
 *   - at most one interruption per 3 minutes
 *   - the session cap scales with content read, not with "session" — a
 *     textbook chapter earns more than a news article because it is more
 *   - an absolute per-session ceiling so a pathological loop still terminates
 *   - never twice on the same paragraph
 *   - never on `unknown`
 *   - consecutive dismissals raise the bar — three in a row is the reader
 *     telling you to stop, and that is more reliable than any inference
 *
 * A wrong interruption costs more than a missed one. When in doubt, decline.
 *
 * Superseded: a flat five-per-session cap. It used the same number for a
 * two-minute article and a three-hour chapter, and failed readers of long or
 * difficult material — the denominator was the defect, not the existence of
 * a cap. `baseAllowance` below is what that flat number becomes: the floor
 * every session starts with, before anything is read.
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
  // The cap for a session that has read nothing yet — and the floor under
  // every session regardless of how much has been read since.
  baseAllowance:     5,
  // One more interruption earned per this many tracked prose paragraphs read
  // (paragraph-tracker), or per this many minutes of measured reading time
  // (accumulated paragraph dwell, the same input progression-entropy uses)
  // — whichever dimension shows more content covered. Either alone is
  // sufficient evidence of "read a lot": dense material racks up dwell time
  // per paragraph, sparse material racks up paragraph count.
  paragraphsPerUnit: 4,
  minutesPerUnit:    3,
  // Pathological-loop backstop. Not the normal way the cap is reached.
  absoluteCeiling:   25,
  minConfidence:     0.5,
  // Skimming is usually deliberate and interrupting it is obnoxious. The one
  // case worth acting on is speed through genuinely dense text, which is what
  // comprehension-monitor already gates its too_fast signal on.
  skimmingGrades:    ['difficult', 'very_difficult'],
  // Consecutive dismissals (question card closed without an answer) raise
  // the bar before lowering it back to silence outright. Reset by any
  // answer, correct or incorrect — engaging with the card at all, not just
  // getting it right, is what says the reader hasn't tuned the system out.
  dismissalBackoff: {
    raiseConfidenceAfter: 2,   // 2nd consecutive dismissal: require more confidence
    raisedMinConfidence:  0.75,
    stopAskingAfter:      3,  // 3rd consecutive dismissal: stop asking until an answer
  },
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
  const budget         = {
    ...DEFAULT_BUDGET, ...(config.budget || {}),
    dismissalBackoff: { ...DEFAULT_BUDGET.dismissalBackoff, ...((config.budget || {}).dismissalBackoff || {}) },
  };
  const now            = config.now || (() => Date.now());
  // Injectable so the sampling rate is assertable under a deterministic RNG.
  const random         = config.random || Math.random;
  const explorationRate = config.explorationRate ?? EXPLORATION_SAMPLE_RATE;

  let lastAt = 0;
  let count  = 0;
  const seenParagraphs = new Set();

  // Content-read accounting. Fed by recordCoverage(), which the orchestrator
  // calls once per paragraph the reader actually leaves (paragraph-tracker's
  // transition.left) — never on media landmarks, which were never prose.
  let paragraphsRead = 0;
  let msRead = 0;

  let consecutiveDismissals = 0;

  function sessionCap() {
    const paragraphUnits = Math.floor(paragraphsRead / budget.paragraphsPerUnit);
    const minuteUnits = Math.floor(msRead / (budget.minutesPerUnit * 60000));
    const earned = budget.baseAllowance + Math.max(paragraphUnits, minuteUnits);
    return Math.min(budget.absoluteCeiling, earned);
  }

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

    /* A question is the one action that can be dismissed — a nudge is not a
     * test. So the backoff only ever narrows 'ask', never 'nudge': a reader
     * who dismisses questions three times in a row is refusing to be tested,
     * not refusing to be told they slowed down. */
    if (action === 'ask') {
      const { raiseConfidenceAfter, raisedMinConfidence, stopAskingAfter } = budget.dismissalBackoff;
      if (consecutiveDismissals >= stopAskingAfter) {
        return deny(`declined ${consecutiveDismissals} questions in a row — holding off until answered`);
      }
      if (consecutiveDismissals >= raiseConfidenceAfter && state.confidence < raisedMinConfidence) {
        return deny(`confidence ${state.confidence.toFixed(2)} below the raised bar of ${raisedMinConfidence} after ${consecutiveDismissals} consecutive dismissals`);
      }
    }

    const cap = sessionCap();
    if (count >= cap) {
      return deny(`session budget spent (${count}/${cap}, ceiling ${budget.absoluteCeiling})`);
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

  /* A content-triggered interruption — not derived from a detected reading
   * state, so it never touches STATE_ACTIONS, confidence, the skimming-grade
   * check or dismissal backoff, none of which describe "the page itself is
   * about to reveal something" (see pretest.js). It still spends from
   * exactly the same budget as every state-driven interruption — session
   * cap, the three-minute gap, never twice on the same paragraph — sharing
   * `count`/`lastAt`/`seenParagraphs` with evaluate() rather than keeping a
   * second pool: CLAUDE.md's "reader-initiated actions spend no budget" is
   * about actions the reader took, and a page-content-triggered prompt they
   * did not ask for is not that. `record()` below is unchanged and already
   * state-agnostic — it only reads `decision.allow`/`.paragraphKey` — so it
   * is reused as-is for this path too. */
  function evaluateContentTrigger(ctx = {}) {
    const deny = (reason) =>
      ({ allow: false, action: 'pretest', reason, evidence: ctx.evidence || [], paragraphKey: null });

    const cap = sessionCap();
    if (count >= cap) {
      return deny(`session budget spent (${count}/${cap}, ceiling ${budget.absoluteCeiling})`);
    }

    const since = now() - lastAt;
    if (lastAt !== 0 && since < budget.minGapMs) {
      return deny(`only ${Math.round(since / 1000)}s since the last interruption`);
    }

    const key = ctx.paragraphKey || null;
    if (key && seenParagraphs.has(key)) {
      return deny('already interrupted on this paragraph');
    }

    return {
      allow: true,
      action: 'pretest',
      reason: 'pretest trigger matched',
      evidence: ctx.evidence || [],
      paragraphKey: key,
      wasExplorationSample: false,
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

  /* Called once per paragraph the reader actually leaves — see
   * orchestrator.js's syncParagraph, fed from paragraph-tracker's
   * transition.left. Never called for media landmarks (figures, tables,
   * code blocks): they were tracked so the reading line could find them, not
   * because they are prose, and counting them here would let a page full of
   * screenshots earn a reader's interruption budget. Reader-initiated
   * reading — a quiz the reader asked for — spends no budget on its own and
   * has no reason to call this either. */
  function recordCoverage({ words, dwellMs, media } = {}) {
    if (media) return;
    if (dwellMs > 0) msRead += dwellMs;
    if (words > 0) paragraphsRead += 1;
  }

  /* The question card was closed without an answer. Declining to be tested
   * asserts nothing about comprehension (CLAUDE.md, signal hierarchy) — but
   * it is still the reader's clearest available signal about whether they
   * want to keep being asked, and three in a row is treated as exactly
   * that: an instruction, not an inference. */
  function recordDismissal() {
    consecutiveDismissals += 1;
  }

  /* Any answer — correct or incorrect — is engagement with the card, which
   * is what the backoff exists to detect the absence of. Reset regardless of
   * correctness: this is not about performance, only about willingness to
   * be tested at all. */
  function recordAnswered() {
    consecutiveDismissals = 0;
  }

  return {
    evaluate,
    evaluateContentTrigger,
    record,
    recordCoverage,
    recordDismissal,
    recordAnswered,
    stats: () => ({
      count, lastAt,
      cap: sessionCap(),
      absoluteCeiling: budget.absoluteCeiling,
      remaining: Math.max(0, sessionCap() - count),
      paragraphsRead, msRead,
      consecutiveDismissals,
    }),
    reset() {
      lastAt = 0; count = 0; seenParagraphs.clear();
      paragraphsRead = 0; msRead = 0; consecutiveDismissals = 0;
    },
  };
}
