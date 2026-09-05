/* scroll-kinematics-tracker.js — session-wide scroll-motion summary
 * (item DC-1a)
 *
 * Not a signals/ detector: it feeds nothing into state-engine.js and asserts
 * nothing about comprehension — it exists only to summarise how a session's
 * scrolling looked, for the one caller that reports it server-side under a
 * bounded exception (see host.js's submitKinematics and
 * src/shared/kinematics.js). Lives directly under src/content/, the same
 * place session-tracker.js does, for the same reason: both are whole-session
 * accumulators, not corroborating signals, so the signals/ detector contract
 * (update()/signal(), state-engine.js registration) does not apply to either.
 *
 * scroll-dynamics.js already computes a conceptually similar "jerk" and
 * "reversals" pair, but only over a rolling ~4s window that is discarded on
 * every read — nothing before this item retained scroll velocity across a
 * whole session. This module does that retention and the session-end
 * arithmetic; it does not reuse scroll-dynamics.js's own jerk formula
 * verbatim (jerk divides by dt, a true px/ms^2 second derivative) because
 * the requested jitter_score is explicitly "mean absolute deviation of
 * successive velocities" — the velocities themselves, not a further
 * derivative. Both are legitimate, different numbers from the same raw
 * scroll stream.
 *
 * Only velocities (and the deltas needed for the micro-correction check) are
 * retained, not raw {y, t} pairs — cheaper, and it is all every requested
 * statistic needs. Capped at MAX_SAMPLES so a multi-hour tab left open
 * scrolling does not grow this unboundedly; oldest samples drop first, the
 * same shape session-tracker.js's own wpmReadings cap already uses.
 */

const MAX_SAMPLES = 20000;
const MICRO_CORRECTION_PX = 50;
const ACCELERATION_MULTIPLE = 2;
const SMOOTH_CHANGE_RATIO = 0.10;

export function createScrollKinematicsTracker(opts = {}) {
  const now = opts.now || (() => Date.now());

  let lastY = null;
  let lastT = null;
  let eventCount = 0;
  const velocities = [];
  const deltas = []; // parallel to velocities — the raw px delta for the same step

  function update(scrollY, at) {
    const t = at ?? now();
    eventCount++;
    if (lastY === null) { lastY = scrollY; lastT = t; return; }
    const dt = t - lastT;
    if (dt <= 0) { lastY = scrollY; lastT = t; return; } // duplicate/out-of-order timestamp, same guard scroll-dynamics.js uses
    const delta = scrollY - lastY;
    velocities.push(delta / dt);
    deltas.push(delta);
    if (velocities.length > MAX_SAMPLES) { velocities.shift(); deltas.shift(); }
    lastY = scrollY;
    lastT = t;
  }

  function percentile(sorted, p) {
    if (sorted.length === 1) return sorted[0];
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function median(sorted) { return percentile(sorted, 0.5); }

  /* Returns null when there is not enough scroll history for the numbers to
   * mean anything — the caller (host.js's submitKinematics via content.js/
   * viewer.js) treats null exactly like "nothing to send", the same way an
   * under-30s session already sends nothing. Two velocity samples is the
   * bare minimum for a variance/MAD that isn't trivially zero. */
  function summary() {
    if (velocities.length < 2) return null;

    const sortedAbs = velocities.map(Math.abs).sort((a, b) => a - b);
    const sortedSigned = [...velocities].sort((a, b) => a - b);
    const mean = velocities.reduce((a, v) => a + v, 0) / velocities.length;
    const variance = velocities.reduce((a, v) => a + (v - mean) ** 2, 0) / velocities.length;
    const medianAbsVelocity = median(sortedAbs);

    let jitterSum = 0;
    let microCorrections = 0;
    let accelerationEvents = 0;
    let directionChanges = 0;
    let smoothCount = 0;
    // Guard against a near-stationary median making ">2x" trip on ordinary
    // noise — the same kind of near-zero-denominator guard smooth-ratio's
    // own division below needs.
    const accelerationFloor = Math.max(medianAbsVelocity, 1e-6);

    for (let i = 1; i < velocities.length; i++) {
      const v = velocities[i], prev = velocities[i - 1];
      jitterSum += Math.abs(v - prev);
      if (Math.abs(v - prev) > ACCELERATION_MULTIPLE * accelerationFloor) accelerationEvents++;
      if (v * prev < 0) directionChanges++;
      const prevMag = Math.abs(prev);
      if (prevMag > 1e-6 && Math.abs(v - prev) / prevMag < SMOOTH_CHANGE_RATIO) smoothCount++;
    }
    for (const delta of deltas) {
      if (delta < 0 && Math.abs(delta) < MICRO_CORRECTION_PX) microCorrections++;
    }

    return {
      scroll_events: eventCount,
      velocity_p50: median(sortedSigned),
      velocity_p95: percentile(sortedSigned, 0.95),
      velocity_variance: variance,
      jitter_score: jitterSum / (velocities.length - 1),
      micro_correction_count: microCorrections,
      micro_correction_rate: microCorrections / eventCount,
      acceleration_events: accelerationEvents,
      direction_changes: directionChanges,
      smooth_scroll_ratio: smoothCount / (velocities.length - 1),
    };
  }

  function reset() {
    lastY = null; lastT = null; eventCount = 0;
    velocities.length = 0; deltas.length = 0;
  }

  return { update, summary, reset };
}
