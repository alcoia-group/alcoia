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

/* ===========================================================================
 * Intervention Policy Reconstruction (step 23) -- the policy ACTION VOCABULARY
 * ===========================================================================
 *
 * `decision.action` above (`'ask' | 'nudge' | 'none' | 'pretest' | 'retention'`)
 * is, and remains, the literal dispatch string host.js's onIntervention and
 * checkRetentionCandidate switch on to decide WHAT TO RENDER — unchanged by
 * this item, on purpose: it is also, indirectly, the server's wire contract
 * (reportIntervention's own `type` argument, constrained server-side by
 * interventions.type's CHECK to exactly 'ask'/'session_recall'/'quiz'/
 * 'retention' — confirmed by reading alcoiaServer's own migration before
 * touching anything here). Renaming it would be a wire-protocol change this
 * item's own §16 explicitly rules out absent a real necessity, and none was
 * found: every one of the 8 policy outcomes below already renders through
 * one of the existing dispatch strings (see "renders as" on each).
 *
 * `decision.policyAction` is NEW: the finer-grained, 8-value vocabulary this
 * item's own brief asks for, added alongside `action`, never replacing it.
 * Several policyActions share one rendering (`action`) on purpose — the
 * brief's own words: "These are policy outcomes, not necessarily eight
 * independent UI components." What's new in THIS item is the policy's
 * ability to tell these cases apart and choose between them; a from-scratch
 * UI component per action is explicitly not required and not built here.
 *
 * -- The eight outcomes, exact meaning, eligibility, and rendering --
 *
 *   none              Nothing warrants a reader-visible event right now.
 *                      Every denial (`deny()` below) is `policyAction: 'none'`
 *                      regardless of what it almost became — "no action" has
 *                      one meaning in this vocabulary, not eight shades of it.
 *                      Renders as: nothing (`allow: false`).
 *
 *   nudge             A reader told the system (self-report) they've lost
 *                      interest or focus — STATES.DRIFTING, self-report-only,
 *                      unchanged from before this item (state-engine.js's own
 *                      STATES comment: no passive drifting detector exists).
 *                      Renders as: `action: 'nudge'` (ui-controller.js's
 *                      showNudge — a 2.2s CSS highlight, nothing else).
 *
 *   attention         A real, classified signal too weak on its own to
 *                      justify interrupting with a question, but still worth
 *                      a near-zero-cost visual accent rather than silence.
 *                      NEW in this item. The one eligibility path today:
 *                      STATES.SKIMMING on text that does NOT clear
 *                      `budget.skimmingGrades` (ordinary-difficulty text) —
 *                      previously a bare denial (see "REPLACE" in this
 *                      item's own report), now a real, lightweight outcome.
 *                      Renders as: `action: 'nudge'` (the SAME showNudge
 *                      affordance 'nudge' uses — see this comment's own
 *                      opening paragraph on why one rendering can serve two
 *                      policyActions). Still spends from the shared budget,
 *                      consistent with this module's own existing precedent
 *                      that 'nudge' (unquestionably the lightest existing
 *                      action) already spends it too — CLAUDE.md's budget is
 *                      about "not reader-initiated," never about visual
 *                      loudness, and this item does not invent a second,
 *                      budget-exempt tier to avoid relitigating that.
 *
 *   explain           Corroborated-but-not-repeated evidence of difficulty:
 *                      real, secondary evidence agrees with the primary
 *                      signal, but the reader has only encountered this
 *                      passage once. NEW distinction in this item --
 *                      `regressionEvidenceStrength()` already computed
 *                      exactly this split (`repeated` vs `corroborated`)
 *                      since step 8, but both previously collapsed into the
 *                      same 'ask' outcome once `boosted` was true. Only
 *                      reachable today via a regression-sourced STRUGGLING
 *                      candidate; see §7/§10 of this item's own report for
 *                      why it was not generalised to every signal type.
 *                      Renders as: `action: 'ask'`, dispatched by host.js's
 *                      onIntervention to handleExplainOrRepair (NOT
 *                      handleAsk) -- CORRECTED by Step 29's own trace of the
 *                      actual code rather than this comment: this paragraph
 *                      originally said EXPLAIN rendered through handleAsk's
 *                      own retrieval-question flow, with a distinct
 *                      generation/UI path left as a "disclosed follow-up,
 *                      not built here". That was accurate when this comment
 *                      was written (Step 23) but is stale now -- Step 24,
 *                      landing after it, DID build that distinct path
 *                      (fetchSummary mode 'explain_more' + question-card.js's
 *                      showExplanation(), see handleExplainOrRepair's own
 *                      header) and host.js's onIntervention has routed
 *                      policyAction 'explain' there, not to handleAsk, ever
 *                      since. `action` stays 'ask' only because that is what
 *                      tells onIntervention this decision renders through
 *                      the question-card shell at all (POLICY_ACTIONS' own
 *                      header above) -- it does not mean "the same card
 *                      'retrieve' shows", which this paragraph used to imply.
 *
 *   retrieve          The primary intervention -- a retrieval question about
 *                      the passage. Semantically identical to the pre-
 *                      existing 'ask' outcome for every STRUGGLING/dense-
 *                      SKIMMING candidate whose evidence is strong enough on
 *                      its own (repeated regression, or any non-regression
 *                      STRUGGLING signal that already cleared confidence/
 *                      backoff).
 *                      Renders as: `action: 'ask'`.
 *
 *   repair            A retrieval was already attempted recently and failed
 *                      (`lastAnswerCorrect === false`, recordAnswered()'s own
 *                      tracking since step 8) -- the next candidate that
 *                      would otherwise be 'retrieve' is reframed as repair
 *                      instead of a cold re-ask. NEW in this item. This is
 *                      distinct from, and does not replace, question-card.js's
 *                      own pre-existing, automatic, SAME-CARD explanation
 *                      offer on a wrong answer (`offerExplanation`, fires
 *                      instantly, no policy decision needed, unchanged) --
 *                      this policy-level 'repair' instead governs the NEXT
 *                      struggling candidate the policy evaluates, so it
 *                      arrives already framed as a follow-up rather than a
 *                      fresh cold question. Never repeats the literal same
 *                      question -- it only ever fires for a NEW paragraph
 *                      (seenParagraphs' own per-paragraph dedup, unchanged,
 *                      already guarantees this function is never re-evaluated
 *                      for an already-asked passage).
 *                      Renders as: `action: 'ask'`.
 *
 *   apply             Defined for vocabulary completeness; NOT REACHABLE
 *                      today. No eligibility path in this file ever produces
 *                      it, and none should until a real generation capability
 *                      backs it: epistemic-engine.js's own LADDER is
 *                      `['recognition', 'free_recall', 'scenario',
 *                      'adversarial']` -- no 'apply' rung -- and
 *                      alcoiaServer's own CLAUDE.md (§15, "Open questions")
 *                      is explicit that the difficulty-ladder levels beyond
 *                      recall/explain (an "apply this concept" question
 *                      included) need a validator this codebase does not
 *                      have yet, and must not ship without one ("Do not
 *                      weaken the span rule"). Inventing an 'apply' eligibility
 *                      path with no real question type behind it would mean
 *                      a policy decision generation can't fulfil -- flagged
 *                      as a real, open architectural gap in this item's own
 *                      report, not silently built around.
 *
 *   delayed_retrieve  A server-scheduled retention item, due, and matched to
 *                      a paragraph the reader is ALREADY reading --
 *                      evaluateRetentionCandidate()'s own pre-existing
 *                      'retention' outcome, relabelled (not rebuilt) in this
 *                      vocabulary. The boundary this item's own §13 asks for
 *                      was ALREADY true before this item touched anything:
 *                      retention never pushes/schedules an interruption on
 *                      its own -- it only ever fires from onParagraphRead,
 *                      requires a live paragraph match, and spends from, and
 *                      is gated by, the exact same budget/cooldown/dismissal-
 *                      backoff/active-card checks as every immediate
 *                      candidate (see evaluateRetentionCandidate's own header
 *                      below, unchanged by this item). "Delayed" describes
 *                      WHEN the underlying knowledge became due, never how
 *                      the interruption itself is gated once due.
 *                      Renders as: `action: 'retention'`.
 *
 * -- Content Intelligence: integration point deliberately left ABSENT --
 *
 * Investigated per this item's own §7 before writing anything: this
 * extension has no existing fetch path for Content Intelligence data (the
 * concept/mapping/relationship graph Steps 17-22 built is server-side and
 * instructor-facing only -- alcoiaConsole reads it, this extension never
 * has). Wiring one here would be new scope this item's own brief does not
 * ask for ("do not invent behaviour merely to use the new tables"), so no
 * `policyContext.contentIntelligence` parameter was added. If a future item
 * wires real Content Intelligence context into this policy, it must arrive
 * exactly that way -- an optional, read-only context field this function
 * MAY consult, never a rule of the shape `if (concept.hasPrerequisite)
 * retrieve()`. This policy remains the sole authority over whether/how to
 * intervene regardless of what any future context field says.
 *
 * -- The four concerns, and where each one lives (this item's own §6) --
 *
 *   A. Signal detection ("what is happening?")   -- state-engine.js, the
 *      signals/ detectors, scroll-regression.js's own repeat/corroboration
 *      facts. Entirely unchanged by this item (KEEP) -- this file consumes
 *      their output, never re-derives it.
 *   B. Policy ("what should alcoia do?")          -- THIS FILE. evaluate(),
 *      evaluateContentTrigger(), evaluateRetentionCandidate() below, now
 *      returning the 8-value vocabulary described above alongside the
 *      existing render-dispatch `action`.
 *   C. Generation ("what should it say or ask?")  -- host.js's
 *      fetchQuestions/fetchSummary, calling the existing, unchanged server
 *      endpoints (POST /api/questions, /api/summarize) -- never a client-
 *      side AI call, never a new provider, never touched by this item.
 *   D. Evidence ("what happened after?")          -- record()/
 *      recordDismissal()/recordAnswered() below (unchanged shapes, same
 *      three functions), response-signals.js, and outcomes.js's real
 *      submission to the server -- this is what feeds Knowledge State,
 *      NEVER a direct write from this file (this module has no network
 *      access, no storage access, and no Knowledge State import of any
 *      kind -- confirmed by this file's own import list, three lines up).
 *
 * -- Fixed-interval audit (this item's own §9) --
 *
 * Two candidate "arbitrary timing" mechanisms exist in this codebase and
 * were both checked directly, not assumed innocent: `budget.minGapMs` (the
 * 3-minute cooldown, below) is a MINIMUM GAP -- a rate limiter between
 * evidence-driven decisions, not a trigger that fires on its own; it can
 * only ever make an already-earned decision wait, never manufacture one.
 * orchestrator.js's `IDLE_TICK_MS` (5s) is a re-evaluation tick -- it
 * re-runs signal collection/pumping so a reader who stopped scrolling is
 * still observed, but it asks the SAME evidence-driven evaluate() this file
 * exports; it has no path of its own to `record()` or to bypass any check
 * here. Neither is "every N minutes, ask a question regardless of evidence"
 * -- no such mechanism was found anywhere in this codebase, so none was
 * removed or replaced; this paragraph is the audit trail that was actually
 * done, not a silent skip.
 */
export const POLICY_ACTIONS = Object.freeze({
  NONE:             'none',
  NUDGE:            'nudge',
  ATTENTION:        'attention',
  EXPLAIN:          'explain',
  RETRIEVE:         'retrieve',
  REPAIR:           'repair',
  APPLY:            'apply',             // defined, not yet reachable -- see header above
  DELAYED_RETRIEVE: 'delayed_retrieve',
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

  /* Returns { allow, action, reason, evidence, paragraphKey,    * interventionId }. `reason` is always populated, including on refusal —
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
    // policyAction is always 'none' on a denial -- see POLICY_ACTIONS' own
    // header comment above: "no action" has one meaning in this vocabulary,
    // regardless of what a candidate almost became.
    const deny = (reason) =>
      ({ allow: false, action: 'none', policyAction: POLICY_ACTIONS.NONE, reason, evidence: [], paragraphKey: null, interventionId: null });

    if (!state || !state.label) return deny('no state');
    if (state.label === STATES.UNKNOWN) return deny('state is unknown');

    let action = STATE_ACTIONS[state.label] || 'none';
    // Step 23: the new 8-value vocabulary, derived from `action` and refined
    // below as more evidence is examined -- see POLICY_ACTIONS' own header
    // comment for the full meaning of each value.
    let policyAction = action === 'ask' ? POLICY_ACTIONS.RETRIEVE
      : action === 'nudge' ? POLICY_ACTIONS.NUDGE
      : POLICY_ACTIONS.NONE;

    // No state-to-action entry means no action. There is no sampling: a
    // reader the detector judged on pace is never interrupted for that
    // reason alone.
    if (action === 'none') return deny(`no action for ${state.label}`);

    if (state.confidence < budget.minConfidence) {
      return deny(`confidence ${state.confidence.toFixed(2)} below ${budget.minConfidence}`);
    }

    if (state.label === STATES.SKIMMING) {
      const grade = state.signal && state.signal.readability && state.signal.readability.grade;
      if (!budget.skimmingGrades.includes(grade)) {
        // Step 23 (REPLACE, documented in this item's own report): ordinary-
        // difficulty text moved at speed is real, classified evidence, just
        // too weak on its own to justify a full retrieval interruption --
        // previously denied outright (nothing happened at all); now a real,
        // low-cost ATTENTION outcome, rendered through the SAME lightweight
        // 'nudge' affordance DRIFTING already uses (see POLICY_ACTIONS' own
        // header for why one rendering serves both). Still spends budget,
        // still respects every cooldown/dedup check below -- this is not an
        // exemption, just a different, lighter-weight thing to spend it on.
        action = 'nudge';
        policyAction = POLICY_ACTIONS.ATTENTION;
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

        // Step 23: a genuine repeat on the SAME passage is the stronger of
        // the two signals regressionEvidenceStrength() already distinguishes
        // (state-engine.js's own CONFUSION_REREAD_COUNT threshold) and earns
        // the full retrieval question; corroboration from a SECOND, DIFFERENT
        // signal in the same batch, with no repetition, is real but weaker --
        // worth a direct explanation rather than demanding an answer. Both
        // previously resolved identically once `boosted` was true; this is
        // the new, finer distinction, using only facts this file already
        // computed, no new threshold.
        policyAction = strength.repeated ? POLICY_ACTIONS.RETRIEVE : POLICY_ACTIONS.EXPLAIN;
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

      // Step 23: failed-retrieval -> repair. A candidate that has cleared
      // every check above and is still headed for a fresh RETRIEVE is
      // reframed as REPAIR when the reader's most recent graded answer was
      // wrong (recordAnswered()'s own lastAnswerCorrect, step 8, read here
      // for a new purpose -- previously only consulted to SOFTEN a
      // borderline regression candidate when true; now also consulted to
      // ESCALATE a strong one when false). Deliberately does not touch an
      // EXPLAIN candidate -- explain is already the gentler of the two, and
      // downgrading a repair need to an explain would understate it, not
      // correct it. Never a repeat of the same question: this function is
      // only ever evaluated for the CURRENT paragraph, and seenParagraphs
      // below already guarantees a paragraph is never asked about twice in
      // one session, so "repair" always means a genuinely new passage,
      // framed as a follow-up to the recent miss, not the literal same
      // question asked again.
      if (policyAction === POLICY_ACTIONS.RETRIEVE && lastAnswerCorrect === false) {
        policyAction = POLICY_ACTIONS.REPAIR;
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
      // Step 23: the new 8-value vocabulary (POLICY_ACTIONS). Additive --
      // every existing consumer of `action` is unaffected; this is new
      // surface for a future renderer/evidence-reporting path to read, same
      // shape of addition `interventionId` already
      // were before this item.
      policyAction,
      reason: `${state.label} at ${state.confidence.toFixed(2)}`,
      // Evidence goes in front of the reader. An interruption that cannot say
      // what it noticed should not be shown.
      evidence: state.evidence || [],
      paragraphKey: key,
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
      ({ allow: false, action: 'none', policyAction: POLICY_ACTIONS.NONE, reason, evidence: [], paragraphKey: null, interventionId: null });

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

    // ctx.kind === 'focus': an instructor-marked important paragraph of an assigned reading. Same
    // budget and gates as a due item; only the label differs. The evidence line is generic on
    // purpose: the student is told a focus was set, never what the instructor wrote.
    const isFocus = ctx.kind === 'focus';
    return {
      allow: true,
      action: isFocus ? 'focus' : 'retention',
      // Step 23: this is the DELAYED_RETRIEVE outcome in the new
      // vocabulary (see POLICY_ACTIONS' own header). A focus question
      // spends the same budget and gates, so it maps to the same outcome.
      policyAction: POLICY_ACTIONS.DELAYED_RETRIEVE,
      reason: isFocus ? 'instructor-marked part of this reading' : 'retention item due',
      evidence: [isFocus ? 'This part of the reading is worth checking.' : 'Time to check whether this has stuck.'],
      paragraphKey: key,
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
