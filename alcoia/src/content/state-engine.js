/* state-engine.js — single reading-state estimate for alcoia
 *
 * Replaces the two independent pipelines that used to each fire their own
 * popups: comprehension-monitor (signals) and a webcam gaze classifier.
 * The gaze classifier is gone — see the project notes' migration note — so
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
   * stops the system pressing. */
  if (sig.type === 'response') {
    if (sig.subtype === 'incorrect') {
      return {
        label: STATES.STRUGGLING,
        confidence: RESPONSE_CONFIDENCE.incorrect,
        evidence: ['You picked a different answer to the one in the passage'],
        signal: sig,
      };
    }
    if (sig.subtype === 'correct') {
      return {
        label: STATES.ON_PACE,
        confidence: RESPONSE_CONFIDENCE.correct,
        evidence: ['You answered that correctly'],
        signal: sig,
      };
    }
    // Dismissed without answering. A refusal to be tested is the reader's
    // right and says nothing about their comprehension, so it asserts nothing.
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
    confidence: 0,
    evidence: [],
    at: now(),
    signal: null,
  };

  function emit(next) {
    const changed = next.label !== current.label ||
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
          confidence: clamp01(proposal.confidence),
          evidence: proposal.evidence || [],
          at,
          signal: proposal.signal || null,
        }
      : {
          label: STATES.UNKNOWN,
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
