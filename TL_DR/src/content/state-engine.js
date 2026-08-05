/* state-engine.js — single reading-state estimate for TL;DR
 *
 * Replaces the two independent pipelines that each fired their own popups:
 * comprehension-monitor (telemetry) and the gaze classifier. Both now feed
 * this engine, which produces one state, and only that state drives
 * interventions. See intervention-policy.js for what happens next.
 *
 * The signal hierarchy from the project notes is enforced structurally, not by
 * convention:
 *
 *   telemetry  → may assert any actionable state
 *   gaze       → may assert ONLY presence/absence, and may corroborate a
 *                telemetry state to raise confidence. It can never, on its
 *                own, claim a reader is struggling.
 *
 * That asymmetry is the whole point. Webcam gaze carries ~180px of error;
 * it knows roughly where someone is looking and whether anyone is there.
 * It does not know whether they understood the paragraph.
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

/* The gaze classifier still emits its original five labels. It is a generated
 * artifact and replacing it needs human approval, so translate at the boundary
 * rather than retraining. `confused` and `overloaded` both collapse to
 * `struggling` — they were never separable observations. */
export const GAZE_LABEL_TO_STATE = Object.freeze({
  focused:    STATES.ON_PACE,
  skimming:   STATES.SKIMMING,
  confused:   STATES.STRUGGLING,
  overloaded: STATES.STRUGGLING,
  zoning_out: STATES.DRIFTING,
});

/* Gaze is trusted for these and nothing else. */
const GAZE_ASSERTABLE = Object.freeze([STATES.ABSENT]);

const DEFAULT_OPTS = {
  gazeQualityFloor:   0.5,    // raised from the old 0.25 — below this, abstain
  gazeStaleMs:        6000,   // no sample for this long, with camera on, = absent
  corroborationBonus: 0.15,   // gaze agreeing with telemetry is worth this much
  idleGraceMs:        4000,
};

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

/* Base confidence per telemetry signal. These are deliberately not 1.0:
 * a speed measurement is evidence, not proof, and the number is shown to
 * nobody as an accuracy claim. */
const TELEMETRY_CONFIDENCE = Object.freeze({
  too_slow:  0.70,
  too_fast:  0.55,
  backtrack: 0.60,
  idle:      0.50,
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
function fromTelemetry(sig) {
  if (!sig || !sig.type) return null;

  if (sig.type === 'speed_mismatch' && sig.subtype === 'too_slow') {
    return {
      label: STATES.STRUGGLING,
      confidence: TELEMETRY_CONFIDENCE.too_slow,
      evidence: [describeTooSlow(sig)],
      signal: sig,
    };
  }

  if (sig.type === 'speed_mismatch' && sig.subtype === 'too_fast') {
    return {
      label: STATES.SKIMMING,
      confidence: TELEMETRY_CONFIDENCE.too_fast,
      evidence: [describeTooFast(sig)],
      signal: sig,
    };
  }

  if (sig.type === 'backtrack') {
    const px = Math.round(sig.backtrackPx || 0);
    return {
      label: STATES.STRUGGLING,
      confidence: TELEMETRY_CONFIDENCE.backtrack,
      evidence: [px ? `You scrolled back ${px}px to re-read` : 'You scrolled back to re-read'],
      signal: sig,
    };
  }

  return null;
}

/* Idle-with-focus is the one genuinely ambiguous case: someone thinking hard
 * and someone who walked away look identical to telemetry. This is where the
 * camera earns its place, and the only place it changes an actionable label. */
function fromIdle(idle, gazeView, opts) {
  if (!idle || !idle.pageFocused) return null;
  const overdue = idle.msSinceInput > (idle.expectedMs || 0) + opts.idleGraceMs;
  if (!overdue) return null;

  if (gazeView.present === false) {
    return {
      label: STATES.ABSENT,
      confidence: 0.65,
      evidence: ['No one appears to be at the screen'],
      cameraUsed: true,
    };
  }
  if (gazeView.present === true) {
    return {
      label: STATES.DRIFTING,
      confidence: TELEMETRY_CONFIDENCE.idle,
      evidence: ['You have been on this paragraph a while without moving on'],
      cameraUsed: true,
    };
  }
  // Camera off or unusable — refuse to guess which it is.
  return {
    label: STATES.UNKNOWN,
    confidence: 0,
    evidence: [],
    cameraUsed: false,
  };
}

/* Reduce a raw gaze reading to what gaze is actually allowed to say. */
function readGaze(gaze, nowMs, opts) {
  const view = { present: null, state: null, quality: 0, usable: false };
  if (!gaze || !gaze.enabled) return view;

  const stale = gaze.lastSampleAt != null &&
                (nowMs - gaze.lastSampleAt) > opts.gazeStaleMs;
  if (stale) { view.present = false; return view; }

  view.quality = typeof gaze.quality === 'number' ? gaze.quality : 0;
  if (view.quality < opts.gazeQualityFloor) return view;   // abstain, do not pass noise on

  view.present = true;
  view.usable  = true;
  view.state   = GAZE_LABEL_TO_STATE[gaze.label] || null;
  return view;
}

export function createReadingStateEngine(config = {}) {
  const opts = { ...DEFAULT_OPTS, ...(config.options || {}) };
  const now  = config.now || (() => Date.now());

  const subscribers = new Set();
  let current = {
    label: STATES.UNKNOWN,
    confidence: 0,
    evidence: [],
    cameraContribution: 0,
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

  /* input: { telemetry, gaze, idle } — any may be absent. */
  function update(input = {}) {
    const at       = now();
    const gazeView = readGaze(input.gaze, at, opts);

    // 1. Telemetry gets first refusal on the label.
    let proposal = fromTelemetry(input.telemetry);
    let cameraContribution = 0;

    if (proposal) {
      // Gaze may only corroborate here — never override, never veto.
      if (gazeView.usable && gazeView.state === proposal.label) {
        proposal.confidence = clamp01(proposal.confidence + opts.corroborationBonus);
        proposal.evidence   = [...proposal.evidence, 'Eye tracking agrees'];
        cameraContribution  = opts.corroborationBonus;
      }
    } else {
      // 2. No telemetry signal. Idle disambiguation is the only path where
      //    gaze changes an actionable label, and it needs telemetry to have
      //    established that the reader is overdue in the first place.
      const idleProposal = fromIdle(input.idle, gazeView, opts);
      if (idleProposal) {
        proposal = idleProposal;
        cameraContribution = idleProposal.cameraUsed ? 0.5 : 0;
      } else if (gazeView.present === false && GAZE_ASSERTABLE.includes(STATES.ABSENT)) {
        // 3. Gaze may assert absence on its own. That is its entire remit —
        //    the GAZE_ASSERTABLE check is what keeps it that way. A gaze
        //    label of `confused` with no telemetry behind it falls through
        //    to `unknown` below, deliberately.
        proposal = {
          label: STATES.ABSENT,
          confidence: 0.6,
          evidence: ['No one appears to be at the screen'],
        };
        cameraContribution = 1;
      }
    }

    const next = proposal
      ? {
          label: proposal.label,
          confidence: clamp01(proposal.confidence),
          evidence: proposal.evidence || [],
          cameraContribution: clamp01(cameraContribution),
          at,
          signal: proposal.signal || null,
        }
      : {
          label: STATES.UNKNOWN,
          confidence: 0,
          evidence: [],
          cameraContribution: 0,
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
