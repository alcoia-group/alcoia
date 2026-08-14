/* scroll-dynamics.js — how the scrolling is being done, not where it went
 *
 * Second derivative of scroll position. Reading produces smooth, repetitive
 * scrolling; hunting for something produces bursts and reversals. This is the
 * one measure that separates a reader deliberately skimming from a reader who
 * has lost the thread and is searching for it — the two look identical to any
 * rate-based signal.
 *
 * Corroboration only. High jerk on its own means someone is moving around a
 * page, which is not a problem to solve.
 */

export function createScrollDynamics(opts = {}) {
  const now        = opts.now || (() => Date.now());
  const windowMs   = opts.windowMs ?? 4000;
  const minSamples = opts.minSamples ?? 6;
  const jerkThreshold = opts.jerkThreshold ?? 0.02;   // px/ms^2

  let samples = [];
  let pending = null;

  function update(scrollY, at) {
    const t = at ?? now();
    samples.push({ y: scrollY, t });
    samples = samples.filter((s) => t - s.t <= windowMs);
    if (samples.length < minSamples) return null;

    // Velocities between consecutive samples, then the mean absolute change in
    // velocity — jerk. Guard against duplicate timestamps.
    const velocities = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      if (dt <= 0) continue;
      velocities.push((samples[i].y - samples[i - 1].y) / dt);
    }
    if (velocities.length < 3) return null;

    let jerkSum = 0;
    let reversals = 0;
    for (let i = 1; i < velocities.length; i++) {
      const dv = velocities[i] - velocities[i - 1];
      const dt = samples[i + 1].t - samples[i].t;
      if (dt > 0) jerkSum += Math.abs(dv / dt);
      if (velocities[i] * velocities[i - 1] < 0) reversals++;
    }
    const jerk = jerkSum / (velocities.length - 1);

    pending = {
      type: 'scroll_jerk', assertable: false,
      jerk, reversals,
      subtype: jerk > jerkThreshold || reversals >= 2 ? 'hunting' : 'smooth',
    };
    return pending;
  }

  function signal() { const s = pending; pending = null; return s; }

  return { update, signal, reset() { samples = []; pending = null; } };
}
