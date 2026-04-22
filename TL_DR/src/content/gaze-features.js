/* gaze-features.js — v2 with DBSCAN noise filtering
   
   What changed from v1:
   Every 2.5 seconds, before computing the 9 features, we run a lightweight
   DBSCAN pass on the raw gaze buffer. Points that are isolated (noise from
   head movement, frame artifacts, iris detection errors) get discarded.
   Only the core cluster — your actual gaze positions — feeds into the features.

   Why DBSCAN fits this problem:
   - Real gaze positions cluster spatially (you're looking at a paragraph)
   - Noise is scattered outliers far from the cluster
   - DBSCAN identifies and discards outliers without assuming any shape
   - It has high noise tolerance — it doesn't need the data to be normally distributed
   - It handles the case where you're reading across a line (elongated cluster)
     better than a circle-based filter would

   Parameters chosen for 30fps webcam gaze:
   - eps: 80px  — two points within 80px are neighbours (one paragraph ~400px wide)
   - minPts: 4  — need at least 4 nearby points to form a cluster core
     (at 30fps over 2.5s = ~75 points, 4 is a low bar — won't discard real data)
*/

// ── Lightweight DBSCAN for 2D gaze points ─────────────────────────────────────
function dbscan(points, eps, minPts) {
  const n       = points.length;
  const labels  = new Array(n).fill(-1);  // -1 = unvisited
  const NOISE   = -2;
  let   cluster = 0;

  function neighbours(idx) {
    const result = [];
    const px = points[idx].x, py = points[idx].y;
    for (let i = 0; i < n; i++) {
      if (i === idx) continue;
      const dx = points[i].x - px;
      const dy = points[i].y - py;
      if (dx*dx + dy*dy <= eps*eps) result.push(i);
    }
    return result;
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;  // already processed

    const nbrs = neighbours(i);
    if (nbrs.length < minPts) {
      labels[i] = NOISE;  // not enough neighbours — mark as noise
      continue;
    }

    // Start a new cluster
    labels[i] = cluster;
    const seed = [...nbrs];

    let j = 0;
    while (j < seed.length) {
      const q = seed[j];
      if (labels[q] === NOISE) labels[q] = cluster;  // border point
      if (labels[q] !== -1)    { j++; continue; }    // already in a cluster

      labels[q] = cluster;
      const qNbrs = neighbours(q);
      if (qNbrs.length >= minPts) {
        // q is a core point — add its neighbours to expand the cluster
        for (const nb of qNbrs) {
          if (!seed.includes(nb)) seed.push(nb);
        }
      }
      j++;
    }
    cluster++;
  }

  return labels;  // array of cluster IDs (-2 = noise, 0+ = cluster index)
}

// ── Filter to largest cluster only ────────────────────────────────────────────
function filterToLargestCluster(points, labels) {
  // Count cluster sizes
  const sizes = {};
  for (const l of labels) {
    if (l >= 0) sizes[l] = (sizes[l] || 0) + 1;
  }

  if (Object.keys(sizes).length === 0) {
    // No clusters found at all — all noise. Return original points as fallback.
    // This happens when the user looks away or covers the camera.
    return points;
  }

  // Find the largest cluster
  const largest = Object.entries(sizes).sort((a,b) => b[1]-a[1])[0][0];

  // Return only points belonging to that cluster
  return points.filter((_, i) => String(labels[i]) === largest);
}

// ── Feature extractor ──────────────────────────────────────────────────────────
export function createFeatureExtractor(opts = {}) {
  const WINDOW_MS  = opts.windowMs  || 2500;
  const MIN_POINTS = opts.minPoints || 15;

  // DBSCAN parameters
  const EPS      = opts.dbscanEps     || 80;   // 80px radius — roughly one word width
  const MIN_PTS  = opts.dbscanMinPts  || 4;    // min 4 neighbours to be a core point

  const buffer = [];
  let lastScrollY  = window.scrollY;
  let scrollDelta  = 0;
  let lineVisits   = {};

  function addPoint(pt) {
    const now = performance.now();
    buffer.push({ x: pt.x, y: pt.y, t: now });

    const currentScroll = window.scrollY;
    scrollDelta += Math.abs(currentScroll - lastScrollY);
    lastScrollY  = currentScroll;

    const lineBand = Math.round(pt.y / 20);
    lineVisits[lineBand] = (lineVisits[lineBand] || 0) + 1;

    // Prune old points outside the window
    const cutoff = now - WINDOW_MS;
    while (buffer.length > 0 && buffer[0].t < cutoff) buffer.shift();
  }

  function computeFeatures() {
    if (buffer.length < MIN_POINTS) return null;

    // ── DBSCAN PASS: remove noise before computing features ──────────────
    let cleanPoints;
    if (buffer.length >= EPS / 5) {
      // Only run DBSCAN when we have enough points for it to be meaningful.
      // Skip if buffer is very small to avoid discarding everything.
      const labels = dbscan(buffer, EPS, MIN_PTS);
      cleanPoints  = filterToLargestCluster(buffer, labels);

      // Safety: if DBSCAN removed more than 60% of points, the signal is too
      // noisy to classify reliably. Return null to skip this cycle.
      if (cleanPoints.length < buffer.length * 0.4) return null;
    } else {
      cleanPoints = buffer;
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── Fixations from clean points ───────────────────────────────────────
    const fixations = [];
    let fixStart = 0;
    for (let i = 1; i <= cleanPoints.length; i++) {
      const prev = cleanPoints[i - 1];
      const curr = cleanPoints[i] || null;
      const dist = curr
        ? Math.hypot(curr.x - prev.x, curr.y - prev.y)
        : Infinity;
      if (dist > 30 || !curr) {
        const duration = prev.t - cleanPoints[fixStart].t;
        if (duration > 50) fixations.push(duration);
        fixStart = i;
      }
    }

    const avgFixationMs = fixations.length > 0
      ? fixations.reduce((a, b) => a + b, 0) / fixations.length
      : 200;
    const fixationStd = fixations.length > 1
      ? Math.sqrt(
          fixations.map(v => (v - avgFixationMs) ** 2).reduce((a, b) => a + b, 0)
          / fixations.length
        )
      : 50;

    // ── Saccades from clean points ────────────────────────────────────────
    const saccadeLengths = [];
    let regressions = 0;
    for (let i = 1; i < cleanPoints.length; i++) {
      const dx   = cleanPoints[i].x - cleanPoints[i-1].x;
      const dy   = cleanPoints[i].y - cleanPoints[i-1].y;
      const dist = Math.hypot(dx, dy);
      if (dist > 30) {
        saccadeLengths.push(dist);
        if (dx < -20) regressions++;
      }
    }

    const saccadeLength = saccadeLengths.length > 0
      ? saccadeLengths.reduce((a, b) => a + b, 0) / saccadeLengths.length
      : 80;
    const saccadeStd = saccadeLengths.length > 1
      ? Math.sqrt(
          saccadeLengths.map(v => (v - saccadeLength) ** 2).reduce((a, b) => a + b, 0)
          / saccadeLengths.length
        )
      : 30;
    const regressionRate = saccadeLengths.length > 0
      ? regressions / saccadeLengths.length
      : 0.1;

    // ── Gaze drift from clean points ──────────────────────────────────────
    const ys      = cleanPoints.map(p => p.y).sort((a, b) => a - b);
    const medianY = ys[Math.floor(ys.length / 2)];
    const gazeDriftPx = cleanPoints.reduce((acc, p) =>
      acc + Math.abs(p.y - medianY), 0) / cleanPoints.length;

    // ── Velocity from clean points ────────────────────────────────────────
    const velocities = [];
    for (let i = 1; i < cleanPoints.length; i++) {
      const dt = Math.max(1, cleanPoints[i].t - cleanPoints[i-1].t) / 1000;
      const d  = Math.hypot(
        cleanPoints[i].x - cleanPoints[i-1].x,
        cleanPoints[i].y - cleanPoints[i-1].y
      );
      velocities.push(d / dt);
    }
    const velocityMean = velocities.length > 0
      ? velocities.reduce((a, b) => a + b, 0) / velocities.length
      : 200;

    // ── Line re-reads (from full buffer — scroll is not affected by DBSCAN) ─
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
    scrollDelta   = 0;
    lineVisits    = {};
    lastScrollY   = window.scrollY;
  }

  return { addPoint, computeFeatures, reset };
}