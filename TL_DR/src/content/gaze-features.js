// gaze-features.js — Windowed feature extractor feeding into the decision tree classifier
// Collects raw gaze points for ~2.5 seconds, then computes the 9 features
// needed by classifier.js

export function createFeatureExtractor(opts = {}) {
  const WINDOW_MS = opts.windowMs || 2500;   // rolling window size
  const MIN_POINTS = opts.minPoints || 15;   // don't classify until we have enough data

  const buffer = [];  // { x, y, t } entries
  let lastScrollY = window.scrollY;
  let scrollDelta = 0;
  let lineVisits = {};  // tracks which y-bands (lines) have been visited

  // Call this with every normalized gaze point from gaze-utils.js
  function addPoint(pt) {
    const now = performance.now();
    buffer.push({ x: pt.x, y: pt.y, t: now });

    // Track scroll
    const currentScroll = window.scrollY;
    scrollDelta += Math.abs(currentScroll - lastScrollY);
    lastScrollY = currentScroll;

    // Track line revisits — bucket y into ~20px bands (rough line height)
    const lineBand = Math.round(pt.y / 20);
    lineVisits[lineBand] = (lineVisits[lineBand] || 0) + 1;

    // Prune old points outside the window
    const cutoff = now - WINDOW_MS;
    while (buffer.length > 0 && buffer[0].t < cutoff) buffer.shift();
  }

  function computeFeatures() {
    if (buffer.length < MIN_POINTS) return null;

    // --- Fixations: consecutive points within 30px of each other ---
    const fixations = [];
    let fixStart = 0;
    for (let i = 1; i <= buffer.length; i++) {
      const prev = buffer[i - 1];
      const curr = buffer[i] || null;
      const dist = curr ? Math.hypot(curr.x - prev.x, curr.y - prev.y) : Infinity;
      if (dist > 30 || !curr) {
        const duration = prev.t - buffer[fixStart].t;
        if (duration > 50) fixations.push(duration); // min 50ms to count
        fixStart = i;
      }
    }

    const avgFixationMs = fixations.length > 0
      ? fixations.reduce((a, b) => a + b, 0) / fixations.length
      : 200;

    const fixationStd = fixations.length > 1
      ? Math.sqrt(fixations.map(v => (v - avgFixationMs) ** 2).reduce((a, b) => a + b, 0) / fixations.length)
      : 50;

    // --- Saccades: jumps between fixation clusters ---
    const saccadeLengths = [];
    let regressions = 0;
    for (let i = 1; i < buffer.length; i++) {
      const dx = buffer[i].x - buffer[i - 1].x;
      const dy = buffer[i].y - buffer[i - 1].y;
      const dist = Math.hypot(dx, dy);
      if (dist > 30) {
        saccadeLengths.push(dist);
        if (dx < -20) regressions++; // right→left = regression
      }
    }

    const saccadeLength = saccadeLengths.length > 0
      ? saccadeLengths.reduce((a, b) => a + b, 0) / saccadeLengths.length
      : 80;

    const saccadeStd = saccadeLengths.length > 1
      ? Math.sqrt(saccadeLengths.map(v => (v - saccadeLength) ** 2).reduce((a, b) => a + b, 0) / saccadeLengths.length)
      : 30;

    const regressionRate = saccadeLengths.length > 0
      ? regressions / saccadeLengths.length
      : 0.1;

    // --- Gaze drift from median y (how far off the text line the eye wanders) ---
    const ys = buffer.map(p => p.y).sort((a, b) => a - b);
    const medianY = ys[Math.floor(ys.length / 2)];
    const gazeDriftPx = buffer.reduce((acc, p) => acc + Math.abs(p.y - medianY), 0) / buffer.length;

    // --- Velocity (px/sec) ---
    const velocities = [];
    for (let i = 1; i < buffer.length; i++) {
      const dt = Math.max(1, buffer[i].t - buffer[i - 1].t) / 1000;
      const d = Math.hypot(buffer[i].x - buffer[i - 1].x, buffer[i].y - buffer[i - 1].y);
      velocities.push(d / dt);
    }
    const velocityMean = velocities.length > 0
      ? velocities.reduce((a, b) => a + b, 0) / velocities.length
      : 200;

    // --- Line re-read count: bands visited more than once ---
    const lineRereadCount = Object.values(lineVisits).filter(v => v > 1).length;

    return {
      avg_fixation_ms:   avgFixationMs,
      fixation_std:      fixationStd,
      regression_rate:   regressionRate,
      saccade_length:    saccadeLength,
      saccade_std:       saccadeStd,
      gaze_drift_px:     gazeDriftPx,
      scroll_delta_px:   scrollDelta,
      velocity_mean:     velocityMean,
      line_reread_count: lineRereadCount,
    };
  }

  function reset() {
    buffer.length = 0;
    scrollDelta = 0;
    lineVisits = {};
    lastScrollY = window.scrollY;
  }

  return { addPoint, computeFeatures, reset };
}