/* state-engine.js — single reading-state estimate for alcoia
 *
 * Replaces the two independent pipelines that used to each fire their own
 * popups: comprehension-monitor (signals) and a webcam gaze classifier.
 * The gaze classifier is gone — see CLAUDE.md's migration note — so
 * signals are now the only input, and this module's job is narrower than
 * its name once implied: turn a batch of reading signals into one state
 * estimate, applying corroboration between signals of that one kind.
 *
 * `unknown` is the default and a correct, common answer. The engine never
 * substitutes a plausible-looking state for missing data.
 */

export const STATES = Object.freeze({
  ON_PACE:    'on_pace',
  SKIMMING:   'skimming',
  STRUGGLING: 'struggling',
  DRIFTING:   'drifting',
  ABSENT:     'absent',
  UNKNOWN:    'unknown',
});

/* Item 13a: struggling is not one thing. The "alcoia Evidence Base" research
 * artifact's confusion/overload/boredom section is explicit that these
 * demand OPPOSITE instructional responses — productive confusion should be
 * preserved and worked through, overload should be reduced (segment,
 * simplify, strip extraneous load), and disengagement needs re-engagement,
 * not more of the same question — and that "behavioral separation is hard":
 * both confusion and overload can produce identical slow reading,
 * regressions and long dwell, so "the most reliable disambiguator available
 * to a browser tool is a lightweight probe... a one-tap self-report."
 *
 * `substate` is purely additive — it exists ONLY alongside the unchanged
 * top-level `label`, never replacing or narrowing it. Every existing
 * consumer (intervention-policy.js's STATE_ACTIONS, reading-map, the
 * receipt, diagnostics, the CSS hue tokens) branches on `label` alone and
 * needs no change; `substate` is new surface for the intervention layer to
 * read if it chooses to, nothing more. */
export const SUBSTATES = Object.freeze({
  CONFUSION: 'confusion',
  OVERLOAD:  'overload',
  UNCLEAR:   'unclear',
});

/* The self-report vocabulary is deliberately WIDER than SUBSTATES above —
 * it also covers the disengagement case the same research section
 * describes ("boredom/disengagement" as the third state on this spectrum,
 * needing re-engagement rather than a load reduction or a Socratic prompt).
 * Disengagement is not a `struggling` substate at all — a reader who says
 * "not interested / lost focus" is telling the system it misjudged the
 * PRIMARY state, not just the substate, so that report resolves to
 * STATES.DRIFTING (unchanged, pre-existing top-level state) rather than to
 * a fourth substate value nothing above declares. */
export const SELF_REPORT = Object.freeze({
  CONFUSION:    'confusion',
  OVERLOAD:     'overload',
  DISENGAGED:   'disengaged',
});

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

/* Base confidence per reading signal. These are deliberately not 1.0:
 * a speed measurement is evidence, not proof, and the number is shown to
 * nobody as an accuracy claim. */
/* Reader responses sit above every other signal. Everything else infers
 * comprehension from behaviour; an answer observes it. These confidences are
 * deliberately higher than anything a signal can produce, so that when a
 * reader answers, their answer decides the state. */
const RESPONSE_CONFIDENCE = Object.freeze({
  incorrect: 0.95,
  correct:   0.90,
});

/* A self-report is the reader directly telling the system what is
 * happening, not the system inferring it — the highest-confidence evidence
 * this engine can ever receive, deliberately set above every inferred
 * confidence including RESPONSE_CONFIDENCE.incorrect (0.95) so it always
 * wins strongestAssertion() against anything else batched in the same
 * update() call, and immediately overrides whatever substate would
 * otherwise have been inferred. */
const SELF_REPORT_CONFIDENCE = 1.0;

/* Item 43: grading authority degrades as the difficulty ladder climbs.
 * recognition is deterministic (unchanged, uses RESPONSE_CONFIDENCE above).
 * free_recall and scenario are graded by a model instead — an LLM's
 * judgement must never outrank the client's own deterministic measurement,
 * so a model verdict is capped well below RESPONSE_CONFIDENCE at every
 * level, enforced HERE rather than trusted from whatever produced the
 * signal (see fromSignal() below, which reads sig.gradingMethod/sig.level
 * and never a caller-supplied confidence number). scenario's answer is
 * legitimately outside the passage, so its judgement is the least
 * trustworthy of the two graded levels and sits below free_recall, which at
 * least has the span to compare against. Mirrors (and must stay in sync
 * with) tests/contract/grading.js's own GRADING_CONFIDENCE — that file
 * documents the contract, this one is what actually gets applied. */
const MODEL_RESPONSE_CONFIDENCE = Object.freeze({
  free_recall: 0.75,
  scenario:    0.55,
});

const SIGNAL_CONFIDENCE = Object.freeze({
  too_slow:     0.70,
  too_fast:     0.55,
  backtrack:    0.60,
  idle:         0.50,
  fast_return:  0.72,   // returned mid-thought — still in trouble
  return:       0.58,
  slow_return:  0.40,   // deliberate consolidation; not a problem to solve
  blur_return:  0.68,
});

/* Signals that may only raise confidence in a state something else asserted.
 * A reader selecting text is doing something deliberate, but people select to
 * quote and highlight as well as when stuck, and the extension already opens a
 * summary on selection — asserting on it too would interrupt twice for one
 * action. */
const CORROBORATING_TYPES = Object.freeze([
  'selection', 'copy', 'scroll_jerk', 'progression',
]);

const CORROBORATION = Object.freeze({
  selection:   { states: [STATES.STRUGGLING], bonus: 0.10, evidence: 'You selected part of this passage' },
  copy:        { states: [STATES.STRUGGLING], bonus: 0.12, evidence: 'You copied a phrase from it' },
  scroll_jerk: { states: [STATES.SKIMMING, STATES.STRUGGLING], bonus: 0.08, evidence: 'Your scrolling became uneven here' },
  progression: { states: [STATES.SKIMMING], bonus: 0.08, evidence: 'You have been moving evenly and quickly through the page' },
});

/* Extra conditions before a corroborating signal counts. Without these,
 * "your scrolling became uneven" would be attached to perfectly smooth
 * scrolling, which is worse than saying nothing. */
const CORROBORATION_GUARD = Object.freeze({
  scroll_jerk: (sig) => sig.subtype === 'hunting',
  progression: (sig) => sig.subtype === 'skimming',
});

function describeTooSlow(sig) {
  if (sig.baselineWpm && sig.actualWpm) {
    const factor = (sig.baselineWpm / sig.actualWpm).toFixed(1);
    return `You read this ${factor}x slower than your usual pace`;
  }
  return 'You slowed down a lot here';
}

function describeTooFast(sig) {
  const grade = sig.readability && sig.readability.grade;
  if (grade === 'very_difficult' || grade === 'difficult') {
    return 'You moved through a dense paragraph quickly';
  }
  return 'You moved through this quickly';
}

/* Turn a comprehension-monitor signal into a state proposal. */
function fromSignal(sig) {
  if (!sig || !sig.type) return null;

  /* Ground truth. A wrong answer is a reader failing to retrieve something
   * they have just read — not an inference about it. A correct answer says
   * the reading that triggered the question was fine, and is exactly as
   * informative; it resolves to on_pace, which earns no interruption and
   * stops the system pressing.
   *
   * Item 43: sig.gradingMethod distinguishes a deterministic verdict
   * (recognition — client-side index comparison, RESPONSE_CONFIDENCE) from
   * a model-graded one (free_recall/scenario — MODEL_RESPONSE_CONFIDENCE,
   * always lower). A signal that never says gradingMethod is treated as
   * deterministic — every response-signal record made before this item
   * looked like that, and still does. */
  if (sig.type === 'response') {
    const isModelGraded = sig.gradingMethod === 'model';

    // Belt-and-suspenders: scenario must never assert "wrong" on model
    // judgement alone (a false correction there is worse than a missed one,
    // and it is unrecoverable — the reader stops trusting the system).
    // tests/contract/grading.js's validateGradingResponse() already refuses
    // to produce this combination, but the cost of a false "wrong" here is
    // high enough that this file does not rely solely on the caller having
    // upheld that upstream — a scenario-level 'incorrect' signal, however it
    // arrived, asserts nothing rather than STRUGGLING.
    if (sig.subtype === 'incorrect' && sig.level === 'scenario') return null;

    if (sig.subtype === 'incorrect') {
      return {
        label: STATES.STRUGGLING,
        confidence: isModelGraded
          ? (MODEL_RESPONSE_CONFIDENCE[sig.level] ?? MODEL_RESPONSE_CONFIDENCE.free_recall)
          : RESPONSE_CONFIDENCE.incorrect,
        evidence: [isModelGraded
          ? 'The grader thinks that answer misses something in the passage'
          : 'You picked a different answer to the one in the passage'],
        signal: sig,
      };
    }
    if (sig.subtype === 'correct') {
      return {
        label: STATES.ON_PACE,
        confidence: isModelGraded
          ? (MODEL_RESPONSE_CONFIDENCE[sig.level] ?? MODEL_RESPONSE_CONFIDENCE.free_recall)
          : RESPONSE_CONFIDENCE.correct,
        evidence: [isModelGraded ? 'The grader thinks that answer is right' : 'You answered that correctly'],
        signal: sig,
      };
    }
    // Dismissed without answering (asserts nothing — the reader's right);
    // 'unknown' (the grader could not decide — unknown never interrupts,
    // invariants 5/9); or 'ungraded' (adversarial — the system responds, it
    // does not mark). None of these assert anything about comprehension.
    return null;
  }

  /* Item 13a: the self-report signal — see SELF_REPORT_CONFIDENCE's own
   * comment for why this always outranks everything else. confusion/
   * overload confirm STRUGGLING (unchanged top-level label) and set the
   * substate directly, bypassing classifySubstate()'s inference entirely —
   * a `substate` set here on the returned proposal is honoured as-is by
   * update() below. disengaged resolves to STATES.DRIFTING instead: the
   * reader is saying the system misjudged the PRIMARY state, not merely
   * the substate of a correctly-identified struggle. */
  if (sig.type === 'self_report') {
    if (sig.subtype === SELF_REPORT.CONFUSION) {
      return {
        label: STATES.STRUGGLING,
        substate: SUBSTATES.CONFUSION,
        confidence: SELF_REPORT_CONFIDENCE,
        evidence: ["You said you're stuck or don't get it"],
        signal: sig,
      };
    }
    if (sig.subtype === SELF_REPORT.OVERLOAD) {
      return {
        label: STATES.STRUGGLING,
        substate: SUBSTATES.OVERLOAD,
        confidence: SELF_REPORT_CONFIDENCE,
        evidence: ["You said it's too much at once"],
        signal: sig,
      };
    }
    if (sig.subtype === SELF_REPORT.DISENGAGED) {
      return {
        label: STATES.DRIFTING,
        substate: null,
        confidence: SELF_REPORT_CONFIDENCE,
        evidence: ["You said you're not interested or lost focus"],
        signal: sig,
      };
    }
    return null;
  }

  if (sig.type === 'speed_mismatch' && sig.subtype === 'too_slow') {
    return {
      label: STATES.STRUGGLING,
      confidence: SIGNAL_CONFIDENCE.too_slow,
      evidence: [describeTooSlow(sig)],
      signal: sig,
    };
  }

  if (sig.type === 'speed_mismatch' && sig.subtype === 'too_fast') {
    return {
      label: STATES.SKIMMING,
      confidence: SIGNAL_CONFIDENCE.too_fast,
      evidence: [describeTooFast(sig)],
      signal: sig,
    };
  }

  if (sig.type === 'backtrack') {
    const px = Math.round(sig.backtrackPx || 0);
    return {
      label: STATES.STRUGGLING,
      confidence: SIGNAL_CONFIDENCE.backtrack,
      evidence: [px ? `You scrolled back ${px}px to re-read` : 'You scrolled back to re-read'],
      signal: sig,
    };
  }

  if (sig.type === 'regression') {
    const paras = sig.distance === 1 ? 'a paragraph' : `${sig.distance} paragraphs`;

    // A slow return is a reader who finished a thought and went back to check
    // something. That is competent reading, and reporting it as struggling
    // would be both wrong and rude. Observed, not actionable.
    if (sig.subtype === 'slow_return') {
      return {
        label: STATES.ON_PACE,
        confidence: SIGNAL_CONFIDENCE.slow_return,
        evidence: [`You went back ${paras} to review`],
        signal: sig,
      };
    }

    const evidence = sig.subtype === 'fast_return'
      ? [`You jumped straight back ${paras}`]
      : [`You went back ${paras} to re-read`];

    return {
      label: STATES.STRUGGLING,
      confidence: SIGNAL_CONFIDENCE[sig.subtype] ?? SIGNAL_CONFIDENCE.return,
      evidence,
      signal: sig,
    };
  }

  if (sig.type === 'blur_return') {
    const mins = Math.round((sig.blurMs || 0) / 60000);
    const away = mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : 'a while';
    return {
      label: STATES.STRUGGLING,
      confidence: SIGNAL_CONFIDENCE.blur_return,
      evidence: [`You came back to this paragraph after ${away} away`],
      signal: sig,
    };
  }

  return null;
}

/* Item 13a: the substate classifier. Called once per update(), only when
 * the winning proposal's label is STRUGGLING.
 *
 * A self-report proposal (see fromSignal() above) already carries its own
 * `substate` explicitly — that value is honoured as-is here, never
 * re-derived, since it is ground truth and outranks any inference.
 *
 * For every OTHER struggling proposal (the ordinary signal-driven path):
 * this project has no dedicated confusion/overload signal yet — items
 * 13b/13c/13d build those — so there is genuinely very little evidence to
 * classify on today, which the "alcoia Evidence Base" research artifact's
 * own finding predicts ("behavioral separation is hard... both confusion
 * and overload can produce slow reading, regressions, and long dwell").
 * `proposal.substateHint` is the shape a future dedicated signal is meant
 * to attach — `{ label: 'confusion' | 'overload', confidence: 0..1 }` — so
 * this function is a real threshold check, not a stub that always returns
 * the same thing for its own sake; it simply has nothing to read yet, so
 * it correctly and honestly falls through to 'unclear' every time. */
const SUBSTATE_CONFIDENCE_THRESHOLD = 0.6;

function classifySubstate(proposal) {
  if (proposal.substate) return proposal.substate; // self-report — ground truth, not re-derived
  const hint = proposal.substateHint;
  if (hint && (hint.label === SUBSTATES.CONFUSION || hint.label === SUBSTATES.OVERLOAD)
    && hint.confidence >= SUBSTATE_CONFIDENCE_THRESHOLD) {
    return hint.label;
  }
  return SUBSTATES.UNCLEAR;
}

/* Pick the strongest thing a signal is willing to assert. */
function strongestAssertion(signals) {
  let best = null;
  for (const sig of signals) {
    const proposal = fromSignal(sig);
    if (!proposal) continue;
    if (!best || proposal.confidence > best.confidence) best = proposal;
  }
  return best;
}

export function createReadingStateEngine(config = {}) {
  const now = config.now || (() => Date.now());

  const subscribers = new Set();
  let current = {
    label: STATES.UNKNOWN,
    substate: null,
    confidence: 0,
    evidence: [],
    at: now(),
    signal: null,
  };

  function emit(next) {
    const changed = next.label !== current.label ||
                    next.substate !== current.substate ||
                    Math.abs(next.confidence - current.confidence) > 0.001;
    current = next;
    if (!changed) return current;
    for (const fn of subscribers) {
      try { fn(current); } catch (e) { /* a bad subscriber must not stall the engine */ }
    }
    return current;
  }

  /* input: { reading } — may be a single signal or an array of them. */
  function update(input = {}) {
    const at = now();

    const all = input.reading
      ? (Array.isArray(input.reading) ? input.reading.filter(Boolean) : [input.reading])
      : [];
    const asserting     = all.filter((s) => s && !CORROBORATING_TYPES.includes(s.type));
    const corroborating = all.filter((s) => s && CORROBORATING_TYPES.includes(s.type));

    const proposal = strongestAssertion(asserting);

    if (proposal) {
      // Other signals that agree raise confidence and add their own
      // observation. A corroborating signal alone never gets this far.
      for (const sig of corroborating) {
        const rule = CORROBORATION[sig.type];
        if (!rule || !rule.states.includes(proposal.label)) continue;
        const guard = CORROBORATION_GUARD[sig.type];
        if (guard && !guard(sig)) continue;
        proposal.confidence = clamp01(proposal.confidence + rule.bonus);
        proposal.evidence   = [...proposal.evidence, rule.evidence];
      }
    }

    const next = proposal
      ? {
          label: proposal.label,
          // Item 13a: additive only — null for every label except
          // STRUGGLING, matching every existing consumer's expectations
          // exactly (they never read this field at all today).
          substate: proposal.label === STATES.STRUGGLING ? classifySubstate(proposal) : null,
          confidence: clamp01(proposal.confidence),
          evidence: proposal.evidence || [],
          at,
          signal: proposal.signal || null,
        }
      : {
          label: STATES.UNKNOWN,
          substate: null,
          confidence: 0,
          evidence: [],
          at,
          signal: null,
        };

    return emit(next);
  }

  return {
    update,
    getState: () => ({ ...current }),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
}
