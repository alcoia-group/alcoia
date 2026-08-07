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
 */

const IDLE_MS = 2500;

export function createCursorTracker(opts = {}) {
  const now         = opts.now || (() => Date.now());
  const windowMs    = opts.windowMs ?? 6000;
  const minSamples  = opts.minSamples ?? 8;
  const minR        = opts.minCorrelation ?? 0.6;
  const maxJumpPx   = opts.maxJumpPx ?? 250;
  const idleMs      = opts.idleMs ?? IDLE_MS;

  let samples = [];
  let pending = null;
  let lastMoveAt = 0;

  function update(x, y, at) {
    const t = at ?? now();
    lastMoveAt = t;
    samples.push({ x, y, t });
    samples = samples.filter((s) => t - s.t <= windowMs);
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

    pending = {
      type: 'cursor_reading',
      assertable: false,
      tracking: isReading,
      y: samples[samples.length - 1].y,
      correlation: r,
      descent,
    };
    return pending;
  }

  /* The reading position, or null when the cursor is not being used as a
   * pointer. Null is the common case and callers must handle it. */
  function getPointerY() {
    if (!pending || !pending.tracking) return null;
    if (now() - lastMoveAt > idleMs) return null;   // hand left the mouse
    return pending.y;
  }

  function signal() { const s = pending; pending = null; return s; }

  return {
    update,
    signal,
    getPointerY,
    isTracking: () => !!(pending && pending.tracking) && now() - lastMoveAt <= idleMs,
    reset() { samples = []; pending = null; lastMoveAt = 0; },
  };
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
