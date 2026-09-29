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
import { generateInterventionId } from './signals/intervention-id.js';

/* What each state earns, when it earns anything at all.
 *
 * `ask` is a retrieval question about the passage. It is the primary
 * intervention, not a summary: summarising removes the desirable difficulty
 * that produces retention, and an answer is the only thing in this system that
 * produces ground truth. Explanation is the fallback after a wrong answer, and
 * the renderer also falls back to it when no question can be generated for a
 * passage — see `handleAsk` in content.js. */
// DRIFTING earns 'nudge' — but state-engine.js only ever produces DRIFTING
// from an explicit reader self-report ("not interested / lost focus"), never
// from a passive reading signal (see state-engine.js's own STATES comment).
// This table entry is correct, not misleading, as long as that stays true:
// 'nudge' is a response to something the reader told the system, not a claim
// that drifting is being passively detected. Check `state.isSelfReported` if
// a caller ever needs to confirm that, rather than assuming it from the
// label alone. (ABSENT used to have an entry here too — removed, along with
// the state itself, once the audit confirmed nothing ever produced it.)
export const STATE_ACTIONS = Object.freeze({
  [STATES.STRUGGLING]: 'ask',
  [STATES.DRIFTING]:   'nudge',
  [STATES.SKIMMING]:   'ask',
  [STATES.ON_PACE]:    'none',
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
  // Adaptive intervention policy (intelligence-architecture audit, step 8).
  // A single, uncorroborated genuine scroll-back is weaker evidence than
  // every other STRUGGLING source — see regressionEvidenceStrength()'s own
  // header below for the full reasoning. 2 mirrors state-engine.js's own
  // CONFUSION_REREAD_COUNT exactly — the same repeat count that already
  // earns a confusion-substate hint is what earns a scroll-back-only
  // candidate its interruption too, rather than a second, independently
  // tuned number for the same underlying fact.
  regressionRepeatThreshold: 2,
  // Repeated WRONG answers, like repeated dismissals, are real friction and
  // raise the same kind of bar before the policy fires another 'ask' — a
  // reader who keeps getting asked and keeps missing needs room for the
  // explanation question-card.js already shows them to land, not another
  // question stacked on top of it. A separate counter and a separate config
  // block from dismissalBackoff on purpose: declining a question and
  // getting one wrong are both real friction, but distinct signals worth
  // tracking, and testing, independently — see evaluate()'s own comment at
  // its call site and recordAnswered()'s header.
  failureBackoff: {
    raiseConfidenceAfter: 2,
    raisedMinConfidence:  0.75,
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

/* Step 8 (adaptive intervention policy / candidate-vs-decision boundary).
 *
 * DETECTION IS NOT THE SAME AS AN INTERRUPTION BEING WARRANTED. A genuine
 * scroll-back regression already passed through a real filter before it
 * ever became a signal at all — scroll-regression.js's own header explains
 * that a quick, oculomotor-style correction never resolves into a signal;
 * only a slower return with real dwell at the earlier point does. But even
 * a GENUINE re-read, taken alone, is exactly as ambiguous to this system as
 * it is unremarkable to a fluent human reader who paused once to check
 * something — CLAUDE.md's own "a wrong interruption costs more than a
 * missed one" applies with special force here, since re-reading is
 * ordinary, competent behaviour far more often than it is unresolved
 * difficulty. So a lone regression signal is a CANDIDATE, not an
 * intervention, until something else says otherwise.
 *
 * Returns null when `state` isn't regression-sourced STRUGGLING evidence at
 * all (nothing to weigh); otherwise `{ repeated, corroborated }`, using
 * ONLY evidence this codebase already computes elsewhere — nothing here is
 * a new detector:
 *
 *   - repeated: scroll-regression.js's own sameIndexRereadCount, the exact
 *     repeat count state-engine.js's classifySubstate() already requires
 *     before it will attach a CONFUSION hint. A reader who keeps returning
 *     to the SAME passage is giving materially stronger evidence than one
 *     who went back once.
 *   - corroborated: state-engine.js's own corroboration pass appends a
 *     second evidence line whenever another signal in the same batch
 *     agreed (selection, copy, uneven scrolling…) — evidence.length > 1 is
 *     that fact, already computed, read here rather than re-derived.
 *
 * `slow_return` never reaches here in practice — state-engine.js resolves
 * it straight to ON_PACE, never STRUGGLING, since a slow, deliberate return
 * is competent reading, not struggle — excluded explicitly anyway so this
 * function's own contract does not silently depend on that staying true
 * elsewhere. */
function regressionEvidenceStrength(state, repeatThreshold) {
  const sig = state.signal;
  if (!sig || sig.type !== 'regression' || sig.subtype === 'slow_return') return null;
  return {
    repeated: typeof sig.sameIndexRereadCount === 'number' && sig.sameIndexRereadCount >= repeatThreshold,
    corroborated: Array.isArray(state.evidence) && state.evidence.length > 1,
  };
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
  // Intelligence-architecture audit, step 5. Injectable for the same
  // testability reason `now`/`random` already are above — a test can
  // assert on the exact id a decision carries rather than only its shape.
  const generateId     = config.generateInterventionId || generateInterventionId;

  let lastAt = 0;
  let count  = 0;
  const seenParagraphs = new Set();

  // Content-read accounting. Fed by recordCoverage(), which the orchestrator
  // calls once per paragraph the reader actually leaves (paragraph-tracker's
  // transition.left) — never on media landmarks, which were never prose.
  let paragraphsRead = 0;
  let msRead = 0;

  let consecutiveDismissals = 0;
  // Step 8: two more small, session-local counters, fed the same way
  // consecutiveDismissals already is (a terminal call from host.js after a
  // real answer) — see recordAnswered()'s own header for exactly what each
  // tracks and why they are independent of consecutiveDismissals and of
  // each other.
  let consecutiveIncorrectAnswers = 0;
  let lastAnswerCorrect = null;

  function sessionCap() {
    const paragraphUnits = Math.floor(paragraphsRead / budget.paragraphsPerUnit);
    const minuteUnits = Math.floor(msRead / (budget.minutesPerUnit * 60000));
    const earned = budget.baseAllowance + Math.max(paragraphUnits, minuteUnits);
    return Math.min(budget.absoluteCeiling, earned);
  }

  /* Returns { allow, action, reason, evidence, paragraphKey, wasExplorationSample,
   * interventionId }. `reason` is always populated, including on refusal —
   * it is the only way to debug why an interruption did or didn't happen.
   *
   * interventionId (intelligence-architecture audit, step 5): a fresh,
   * unique identity for THIS specific interruption, minted only when the
   * decision is actually 'ask' — the one action that goes on to produce a
   * question and an attributable outcome. 'nudge' (and every denied
   * decision) carries `interventionId: null`: a nudge has no question, no
   * answer, nothing for a later outcome to be attributed to, so minting an
   * id for it would be an id that could never mean anything. This is the
   * "intervention selected -> create intervention identity" step of the
   * causal chain (see intervention-id.js's own header) — generation and
   * rendering (host.js's handleAsk) happen after, using this same id. */
  function evaluate(state, ctx = {}) {
    const deny = (reason) =>
      ({ allow: false, action: 'none', reason, evidence: [], paragraphKey: null, wasExplorationSample: false, interventionId: null });

    if (!state || !state.label) return deny('no state');
    if (state.label === STATES.UNKNOWN) return deny('state is unknown');

    let action = STATE_ACTIONS[state.label] || 'none';
    let wasExplorationSample = false;

    if (action === 'none') {
      /* Exploration bypasses only this test — the state-to-action table —
       * never the checks below it. A drifting reader is excluded outright:
       * they are not reading the paragraph in front of them, and invariant 8
       * forbids testing someone who did not read, regardless of what
       * exploration wants to learn. (In practice DRIFTING already earns
       * 'nudge' from STATE_ACTIONS above and never reaches this branch at
       * all — the check stays as a defensive guard, not a load-bearing one.)
       * ABSENT used to be excluded here too; removed along with the state. */
      const explorationEligible = state.label !== STATES.DRIFTING;
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

      // Step 8: repeated WRONG answers raise the same kind of bar repeated
      // dismissals already do — a reader who keeps getting asked and keeps
      // missing needs room for the repair question-card.js already shows
      // them (the explanation offered after a wrong answer) to land, rather
      // than another question stacked immediately on top of it. See
      // recordAnswered()'s own header for how the counter moves.
      const { raiseConfidenceAfter: failRaiseAfter, raisedMinConfidence: failRaisedMin } = budget.failureBackoff;
      if (consecutiveIncorrectAnswers >= failRaiseAfter && state.confidence < failRaisedMin) {
        return deny(`confidence ${state.confidence.toFixed(2)} below the raised bar of ${failRaisedMin} after ${consecutiveIncorrectAnswers} consecutive wrong answers`);
      }

      // Step 8: candidate-vs-decision boundary for scroll-back regressions
      // specifically — see regressionEvidenceStrength()'s own header for
      // the full reasoning. `null` means this proposal isn't regression-
      // sourced at all (an incorrect answer, a self-report, a slow-pace or
      // blur-return signal), so every one of those is completely unaffected
      // by this block and falls straight through to the checks below, same
      // as before this item.
      const strength = regressionEvidenceStrength(state, budget.regressionRepeatThreshold);
      if (strength) {
        const boosted = strength.repeated || strength.corroborated;
        if (!boosted) {
          return deny('a single scroll-back is not enough evidence on its own to interrupt — held as a candidate, not acted on');
        }
        // A recent, genuinely successful retrieval is itself real evidence
        // the reader is doing fine — reason enough to hold off on a
        // borderline candidate a moment longer, though not reason enough to
        // override a regression that is BOTH repeated AND corroborated,
        // which is strong evidence in its own right regardless of what the
        // reader's last answer was (requirement 4: this must remain capable
        // of intervening when the evidence is strong, never a blanket
        // "never on scroll-up" rule).
        const doublyBoosted = strength.repeated && strength.corroborated;
        if (lastAnswerCorrect === true && !doublyBoosted) {
          return deny('a recent correct answer means this scroll-back alone is not enough evidence yet to interrupt again');
        }
      }

      // Step 9A (active intervention awareness): a candidate that has
      // already cleared every evidence/adaptation check above is still not
      // promoted to a decision if the reader is already dealing with a
      // question — ctx.questionCardVisible is ground truth from
      // ui-controller.js's own openPopups (see hasVisibleQuestionCard()'s
      // header), transported here by the caller (orchestrator.js, via
      // host.isQuestionCardVisible()), never guessed at by this module.
      // Sits deliberately AFTER evidence-strength so a candidate that was
      // never good enough on its own still reports THAT as the reason, and
      // BEFORE budget/cooldown/paragraph-dedup below, matching this item's
      // own candidate -> evidence -> active-card -> budget ordering. A
      // candidate denied here spends nothing (deny() never touches the
      // dismissal/failure counters, never calls record(), never mints an
      // interventionId) — it is simply not promoted this time, and remains
      // exactly as re-evaluable on the next signal as it always was.
      if (ctx.questionCardVisible) {
        return deny('a question card is already visible — holding off on a redundant interruption');
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
      // See this function's own header comment. Reuses this closure's own
      // injected now()/random() rather than the module-level defaults, so a
      // test constructed with a fixed clock/RNG gets a deterministic id
      // (matters for the existing toEqual-on-the-whole-decision tests in
      // tests/intervention-policy.test.js, which predate this field and
      // must keep passing unmodified).
      interventionId: action === 'ask' ? generateId(now, random) : null,
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

  /* A server-scheduled retention retrieval candidate (intelligence-
   * architecture audit, step 7) — not derived from a detected reading
   * state either, so like evaluateContentTrigger above it skips
   * STATE_ACTIONS/confidence/skimming-grade. Two real differences from
   * evaluateContentTrigger, both deliberate:
   *
   *   - It DOES check dismissal backoff. A retention item is a genuine
   *     question the reader can decline exactly like an 'ask' can, so the
   *     same "declined N in a row, hold off" signal applies — unlike
   *     pretest's occlusion, which the reader never explicitly dismisses
   *     as a question.
   *   - It DOES mint an interventionId. Unlike pretest (which produces no
   *     question and no attributable outcome), a retention retrieval
   *     produces exactly the same question-and-answer flow 'ask' does, so
   *     it needs the same "intervention selected -> create intervention
   *     identity" step evaluate()'s own header describes.
   *
   * Spends from the SAME shared budget/cooldown/dedup state as every other
   * path in this module (count/lastAt/seenParagraphs) — a knowledge unit
   * becoming due does not create a second, parallel interruption budget;
   * see CLAUDE.md's own step 7 entry for why that matters ("due is a
   * candidate, not an order"). `ctx.paragraphKey` is the caller's own
   * computeIdentity(text).paragraphKey for the due paragraph it found a
   * match on — the same dedup key every other path already uses, so a
   * knowledge unit already interrupted-on this session (via 'ask' or an
   * earlier retention attempt) is correctly skipped here too. */
  function evaluateRetentionCandidate(ctx = {}) {
    const deny = (reason) =>
      ({ allow: false, action: 'none', reason, evidence: [], paragraphKey: null, interventionId: null });

    const cap = sessionCap();
    if (count >= cap) {
      return deny(`session budget spent (${count}/${cap}, ceiling ${budget.absoluteCeiling})`);
    }

    const since = now() - lastAt;
    if (lastAt !== 0 && since < budget.minGapMs) {
      return deny(`only ${Math.round(since / 1000)}s since the last interruption`);
    }

    const { raiseConfidenceAfter, stopAskingAfter } = budget.dismissalBackoff;
    if (consecutiveDismissals >= stopAskingAfter) {
      return deny(`declined ${consecutiveDismissals} questions in a row — holding off until answered`);
    }
    // No confidence signal exists for a retention candidate (it isn't
    // derived from a classified reading state), so the raised-bar half of
    // the backoff — which compares against state.confidence — has nothing
    // to compare here. Reaching raiseConfidenceAfter without yet reaching
    // stopAskingAfter is still real hesitation worth respecting: hold off
    // on retention specifically (evaluate()'s own 'ask' path is unaffected)
    // once the reader is visibly declining questions, rather than only
    // acting at the hard stop.
    if (consecutiveDismissals >= raiseConfidenceAfter) {
      return deny(`${consecutiveDismissals} consecutive dismissals — holding off retention until answered`);
    }

    // Step 9A: same active-card gate as evaluate()'s own 'ask' path, same
    // ground truth (ctx.questionCardVisible, ui-controller.js's
    // hasVisibleQuestionCard()) — a retention retrieval renders through the
    // exact same question-card.js machinery an 'ask' does, so it is
    // suppressed by, and itself counts toward, the same "a question is
    // already on screen" fact. Placed in the same relative position as
    // evaluate()'s own check: after every adaptation/dismissal check above,
    // before the paragraph-dedup/budget check below.
    if (ctx.questionCardVisible) {
      return deny('a question card is already visible — holding off on a redundant interruption');
    }

    const key = ctx.paragraphKey || null;
    if (key && seenParagraphs.has(key)) {
      return deny('already interrupted on this paragraph');
    }

    return {
      allow: true,
      action: 'retention',
      reason: 'retention item due',
      evidence: ['Time to check whether this has stuck.'],
      paragraphKey: key,
      wasExplorationSample: false,
      interventionId: generateId(now, random),
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
   * is what the dismissal backoff exists to detect the absence of. Reset
   * unconditionally regardless of correctness: that half is not about
   * performance, only about willingness to be tested at all — unchanged by
   * this item.
   *
   * `correct` (step 8, optional, boolean | null) additionally tracks two
   * new, independent things:
   *   - consecutiveIncorrectAnswers: reset the moment a correct answer
   *     arrives, incremented on a wrong one, left untouched by an
   *     ungraded/unknown verdict — an ungraded answer asserts nothing about
   *     performance, the same treatment CLAUDE.md gives it everywhere else
   *     in this system, so it neither raises nor lowers this counter.
   *   - lastAnswerCorrect: whether the reader's MOST RECENT graded answer
   *     was right — read only by regressionEvidenceStrength()'s call site
   *     in evaluate(), to soften a borderline, single-signal scroll-back
   *     candidate specifically. It never overrides a genuinely strong
   *     signal (an incorrect answer, a self-report): both still fire at
   *     their own full confidence regardless of this flag.
   *
   * Every caller that predates this item — every existing test, and any
   * call site that never passes an argument — gets `correct === undefined`,
   * which falls into the same "ungraded" branch as an explicit `null`:
   * dismissal backoff still resets exactly as before, neither new counter
   * moves. */
  function recordAnswered(correct) {
    consecutiveDismissals = 0;
    if (correct === true) {
      consecutiveIncorrectAnswers = 0;
      lastAnswerCorrect = true;
    } else if (correct === false) {
      consecutiveIncorrectAnswers += 1;
      lastAnswerCorrect = false;
    } else {
      lastAnswerCorrect = null;
    }
  }

  return {
    evaluate,
    evaluateContentTrigger,
    evaluateRetentionCandidate,
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
      // Step 8.
      consecutiveIncorrectAnswers, lastAnswerCorrect,
    }),
    reset() {
      lastAt = 0; count = 0; seenParagraphs.clear();
      paragraphsRead = 0; msRead = 0; consecutiveDismissals = 0;
      consecutiveIncorrectAnswers = 0; lastAnswerCorrect = null;
    },
  };
}
