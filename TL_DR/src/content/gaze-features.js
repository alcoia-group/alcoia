/* gaze-features.js — final version
   
   Changes applied:
   1. DBSCAN noise filter with safe fallback (never returns null due to too much noise)
   2. lineVisits and scrollDelta reset at end of each computeFeatures() window
      so features are per-window, not cumulative across the session
   3. Velocity threshold raised to 1800 px/s (regressions are fast — old 1200 filtered them)
   4. EMA alpha raised in gaze-utils but DBSCAN params tuned here
*/

// ── Lightweight DBSCAN for 2D gaze points ─────────────────────────────────
function dbscan(points, eps, minPts) {
  const n      = points.length;
  const labels = new Array(n).fill(-1);
  const NOISE  = -2;
  let cluster  = 0;

  function nbrs(idx) {
    const res = [], px = points[idx].x, py = points[idx].y;
    for (let i = 0; i < n; i++) {
      if (i === idx) continue;
      const dx = points[i].x - px, dy = points[i].y - py;
      if (dx*dx + dy*dy <= eps*eps) res.push(i);
    }
    return res;
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const nb = nbrs(i);
    if (nb.length < minPts) { labels[i] = NOISE; continue; }
    labels[i] = cluster;
    const seed = [...nb];
    let j = 0;
    while (j < seed.length) {
      const q = seed[j];
      if (labels[q] === NOISE) labels[q] = cluster;
      if (labels[q] !== -1)    { j++; continue; }
      labels[q] = cluster;
      const qn = nbrs(q);
      if (qn.length >= minPts) qn.forEach(x => { if (!seed.includes(x)) seed.push(x); });
      j++;
    }
    cluster++;
  }
  return labels;
}

function filterToLargestCluster(points, labels) {
  const sizes = {};
  for (const l of labels) if (l >= 0) sizes[l] = (sizes[l] || 0) + 1;
  if (!Object.keys(sizes).length) return points; // no clusters — return all (fallback)
  const largest = Object.entries(sizes).sort((a,b) => b[1]-a[1])[0][0];
  return points.filter((_, i) => String(labels[i]) === largest);
}

// ── Feature extractor ──────────────────────────────────────────────────────
export function createFeatureExtractor(opts = {}) {
  const WINDOW_MS  = opts.windowMs    || 2500;
  const MIN_POINTS = opts.minPoints   || 15;
  const EPS        = opts.dbscanEps   || 80;
  const MIN_PTS    = opts.dbscanMinPts|| 4;

  const buffer = [];
  let lastScrollY = window.scrollY;
  let scrollDelta = 0;
  let lineVisits  = {};

  function addPoint(pt) {
    const now = performance.now();
    buffer.push({ x: pt.x, y: pt.y, t: now });

    const currentScroll = window.scrollY;
    scrollDelta += Math.abs(currentScroll - lastScrollY);
    lastScrollY  = currentScroll;

    const lineBand = Math.round(pt.y / 20);
    lineVisits[lineBand] = (lineVisits[lineBand] || 0) + 1;

    const cutoff = now - WINDOW_MS;
    while (buffer.length > 0 && buffer[0].t < cutoff) buffer.shift();
  }

  function computeFeatures() {
    if (buffer.length < MIN_POINTS) return null;

    // ── DBSCAN noise filter ────────────────────────────────────────────────
    let cleanPoints;
    const labels = dbscan(buffer, EPS, MIN_PTS);
    const candidates = filterToLargestCluster(buffer, labels);

    // CRITICAL FIX: never return null due to too much noise.
    // If DBSCAN discards more than 75% of points, fall back to the raw buffer.
    // A noisy classification is better than no classification — returning null
    // keeps lastCogState as 'focused' forever because the classify loop exits early.
    if (candidates.length >= buffer.length * 0.25) {
      cleanPoints = candidates;
    } else {
      cleanPoints = buffer; // fallback — use all points, noisier but classifies
    }

    // ── Fixations ──────────────────────────────────────────────────────────
    const fixations = [];
    let fixStart = 0;
    for (let i = 1; i <= cleanPoints.length; i++) {
      const prev = cleanPoints[i-1];
      const curr = cleanPoints[i] || null;
      const dist = curr ? Math.hypot(curr.x-prev.x, curr.y-prev.y) : Infinity;
      if (dist > 30 || !curr) {
        const duration = prev.t - cleanPoints[fixStart].t;
        if (duration > 50) fixations.push(duration);
        fixStart = i;
      }
    }
    const avgFixationMs = fixations.length > 0
      ? fixations.reduce((a,b) => a+b, 0) / fixations.length : 200;
    const fixationStd = fixations.length > 1
      ? Math.sqrt(fixations.map(v=>(v-avgFixationMs)**2).reduce((a,b)=>a+b,0)/fixations.length) : 50;

    // ── Saccades and regressions ───────────────────────────────────────────
    const saccadeLengths = [];
    let regressions = 0;
    for (let i = 1; i < cleanPoints.length; i++) {
      const dx = cleanPoints[i].x - cleanPoints[i-1].x;
      const dy = cleanPoints[i].y - cleanPoints[i-1].y;
      const d  = Math.hypot(dx, dy);
      if (d > 30) {
        saccadeLengths.push(d);
        if (dx < -20) regressions++;
      }
    }
    const saccadeLength = saccadeLengths.length > 0
      ? saccadeLengths.reduce((a,b)=>a+b,0)/saccadeLengths.length : 80;
    const saccadeStd = saccadeLengths.length > 1
      ? Math.sqrt(saccadeLengths.map(v=>(v-saccadeLength)**2).reduce((a,b)=>a+b,0)/saccadeLengths.length) : 30;
    const regressionRate = saccadeLengths.length > 0
      ? regressions / saccadeLengths.length : 0.1;

    // ── Gaze drift ─────────────────────────────────────────────────────────
    const ys      = cleanPoints.map(p=>p.y).sort((a,b)=>a-b);
    const medianY = ys[Math.floor(ys.length/2)];
    const gazeDriftPx = cleanPoints.reduce((acc,p)=>acc+Math.abs(p.y-medianY),0)/cleanPoints.length;

    // ── Velocity ───────────────────────────────────────────────────────────
    const velocities = [];
    for (let i = 1; i < cleanPoints.length; i++) {
      const dt = Math.max(1, cleanPoints[i].t - cleanPoints[i-1].t) / 1000;
      const d  = Math.hypot(cleanPoints[i].x-cleanPoints[i-1].x, cleanPoints[i].y-cleanPoints[i-1].y);
      velocities.push(d/dt);
    }
    const velocityMean = velocities.length > 0
      ? velocities.reduce((a,b)=>a+b,0)/velocities.length : 200;

    // ── Line re-reads (from full buffer — scroll tracking, not gaze coords) ─
    const lineRereadCount = Object.values(lineVisits).filter(v=>v>1).length;

    // ── CRITICAL FIX: reset per-window accumulators ────────────────────────
    // Capture values before reset, then clear so next window starts fresh.
    const scrollDeltaCapture = scrollDelta;
    lineVisits  = {};
    scrollDelta = 0;
    lastScrollY = window.scrollY;

    return {
      avg_fixation_ms:   avgFixationMs,
      fixation_std:      fixationStd,
      regression_rate:   regressionRate,
      saccade_length:    saccadeLength,
      saccade_std:       saccadeStd,
      gaze_drift_px:     gazeDriftPx,
      scroll_delta_px:   scrollDeltaCapture,
      velocity_mean:     velocityMean,
      line_reread_count: lineRereadCount,
    };
  }

  function reset() {
    buffer.length = 0;
    scrollDelta   = 0;
    lineVisits    = {};
    lastScrollY   = window.scrollY;
  }

  return { addPoint, computeFeatures, reset };
}