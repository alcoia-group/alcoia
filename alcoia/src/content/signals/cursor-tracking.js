/* cursor-tracking.js — the mouse as a reading pointer, when it is one
 *
 * Plenty of readers track text with the cursor. When they do, it is a pointer
 * with pixel accuracy, against roughly 180px of error from webcam gaze. It is
 * available on any machine with a mouse and costs no permission.
 *
 * The catch is that most cursor movement is not reading — it is reaching for a
 * scrollbar, a tab, a link. So this detects the *behaviour* first and only
 * offers a position once the movement looks like tracking: downward progress
 * through the page, correlated with time, without the long jumps of someone
 * navigating. When it does not look like reading, it says nothing and the
 * viewport heuristic stays in charge.
 *
 * `getPointerY()` / `isTracking()`, read directly by paragraph-tracker's
 * override, is one consumer path. The other is `signal()`, which used to
 * exist, emit a `type: 'cursor_reading'` object nothing ever wired up
 * (orchestrator.js never called it; state-engine.js listed the type as
 * corroborating with no `CORROBORATION` entry for it), and was removed
 * outright rather than left as a dead emission path — see CLAUDE.md's
 * "known defects". It is back now, with a deliberately different shape:
 * not the reading-position judgement above, but the mind-wandering
 * kinematics from "Wandering minds, wandering mice" (Computers in Human
 * Behavior, 2020) — when attention drifts, mouse movement reverses
 * direction along the x/y axes more often, and takes longer to resume
 * after a pause. Both are corroboration-only in state-engine.js, wired to
 * bias the 'unclear' struggling substate, never confusion or overload —
 * those are a different signature (CLT overload / productive-confusion
 * literature), not this one.
 *
 * A reader who never moves the mouse — trackpad, touch, keyboard nav,
 * assistive tech — produces no samples, so `signal()` returns null exactly
 * as if this module were not loaded. Absence of movement is never itself
 * evidence; only a specific pattern in movement that did happen is.
 */

const IDLE_MS = 2500;

export function createCursorTracker(opts = {}) {
  const now            = opts.now || (() => Date.now());
  const windowMs       = opts.windowMs ?? 6000;
  const minSamples     = opts.minSamples ?? 8;
  const minR           = opts.minCorrelation ?? 0.6;
  const maxJumpPx      = opts.maxJumpPx ?? 250;
  const idleMs         = opts.idleMs ?? IDLE_MS;
  // "Flipped the cursor more often along the x- and y-axes" — the ratio of
  // consecutive movement steps that reverse direction on either axis.
  // Ordinary reading-with-the-mouse tracking is smooth and monotone
  // downward (see isReading below), so this sits well above what that
  // produces.
  const minFlipRatio   = opts.minFlipRatio ?? 0.35;
  // Sub-pixel jitter while genuinely tracking text (the mouse is never
  // perfectly still while it descends the page) must not count as a
  // direction reversal — only a step big enough to be a real movement can.
  const minFlipStepPx  = opts.minFlipStepPx ?? 3;
  // "Took longer to initiate... responses": alcoia has no periodic probe
  // like the cited study's, so this is operationalised as the delay between
  // a genuine pause (>= idleMs, the same bar getPointerY() already uses for
  // "hand left the mouse") ending and movement resuming — the same
  // underlying construct, slowness to re-engage, without inventing a UI hook.
  const resumeDelayMs  = opts.resumeDelayMs ?? 5000;

  let samples = [];
  let state = null;       // the latest reading judgement — not a drainable signal
  let lastMoveAt = 0;
  let pendingKinematics = null;

  function update(x, y, at) {
    const t = at ?? now();
    // Measured before lastMoveAt is overwritten, and independent of the
    // sample window below — a long gap must be detectable on the single
    // move that ends it, even if that move alone hasn't yet rebuilt enough
    // samples in the window for the flip-ratio measure to speak.
    const gapSincePrev = lastMoveAt ? t - lastMoveAt : 0;
    const resumedSlowly = gapSincePrev >= resumeDelayMs;
    lastMoveAt = t;
    samples.push({ x, y, t });
    samples = samples.filter((s) => t - s.t <= windowMs);

    const flipRatio = samples.length >= minSamples ? axisFlipRatio(samples, minFlipStepPx) : null;
    const highFlip = flipRatio != null && flipRatio >= minFlipRatio;

    // Only ever set when a pattern is actually present — never on mere
    // absence of movement or an ordinary short pause.
    if (highFlip || resumedSlowly) {
      pendingKinematics = {
        type: 'cursor_kinematics',
        assertable: false,
        subtype: 'mind_wandering',
        axisFlipRatio: flipRatio,
        initiationDelayMs: resumedSlowly ? gapSincePrev : null,
      };
    }

    if (samples.length < minSamples) return null;

    // A single large jump means the reader went somewhere, not read something.
    let maxJump = 0;
    for (let i = 1; i < samples.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(samples[i].y - samples[i - 1].y));
    }

    const r = correlation(samples.map((s) => s.t), samples.map((s) => s.y));
    const descent = samples[samples.length - 1].y - samples[0].y;

    // Reading with the mouse means y advances with time, gradually, downward.
    const isReading = r != null && r >= minR && maxJump <= maxJumpPx && descent > 0;

    state = {
      tracking: isReading,
      y: samples[samples.length - 1].y,
      correlation: r,
      descent,
    };
    return state;
  }

  /* The reading position, or null when the cursor is not being used as a
   * pointer. Null is the common case and callers must handle it. */
  function getPointerY() {
    if (!state || !state.tracking) return null;
    if (now() - lastMoveAt > idleMs) return null;   // hand left the mouse
    return state.y;
  }

  /* Corroboration-only mind-wandering kinematics, drained once and cleared —
   * same "pending, cleared on read" shape as interaction-signals.js and
   * progression-entropy.js. Null whenever no qualifying pattern has been
   * observed, including whenever the mouse has not moved at all. */
  function signal() {
    const s = pendingKinematics;
    pendingKinematics = null;
    return s;
  }

  return {
    update,
    getPointerY,
    signal,
    isTracking: () => !!(state && state.tracking) && now() - lastMoveAt <= idleMs,
    reset() { samples = []; state = null; lastMoveAt = 0; pendingKinematics = null; },
  };
}

/* Ratio of consecutive movement steps whose direction reverses on the x or y
 * axis versus the step before it. Null until there is enough movement to
 * compare — a stationary or near-stationary cursor has no direction to flip.
 * Steps smaller than minStepPx never count as a reversal either way — real
 * reading-with-the-mouse tracking wobbles by a pixel or two while descending
 * the page, and that jitter is not the pattern being measured. */
function axisFlipRatio(samples, minStepPx) {
  if (samples.length < 4) return null;
  let flips = 0;
  let comparisons = 0;
  let prevDx = null;
  let prevDy = null;
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i].x - samples[i - 1].x;
    const dy = samples[i].y - samples[i - 1].y;
    if (prevDx != null) {
      comparisons++;
      const xFlip = Math.abs(prevDx) >= minStepPx && Math.abs(dx) >= minStepPx && Math.sign(dx) !== Math.sign(prevDx);
      const yFlip = Math.abs(prevDy) >= minStepPx && Math.abs(dy) >= minStepPx && Math.sign(dy) !== Math.sign(prevDy);
      if (xFlip || yFlip) flips++;
    }
    prevDx = dx;
    prevDy = dy;
  }
  return comparisons > 0 ? flips / comparisons : null;
}

/* Pearson r. Null when either series has no spread — a stationary cursor is
 * not evidence of anything. */
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx < 1e-9 || syy < 1e-9) return null;
  return sxy / Math.sqrt(sxx * syy);
}
