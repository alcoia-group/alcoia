/* reading-time-model.js: how long a paragraph should take THIS reader.
 *
 * The old expectation picked one of four speeds from a difficulty grade, so a paragraph one point past a
 * grade boundary was expected to take 30% longer than one just under it. This is continuous. For a
 * paragraph of W words the expected time is
 *
 *     W x base x (b0 + b1 x (rare - R0) + b2 x (clause - C0))
 *
 * where `base` is the reader's own milliseconds per word on ordinary prose (their personal baseline), `rare`
 * is the share of words outside a common-word list, and `clause` is the mean number of words per clause.
 * The three coefficients b0, b1, b2 are fitted online, per language, by ridge regression pulled towards
 * PRIORS. With no observations the prediction is the prior; as paragraphs are read it moves towards what
 * this reader actually does. It is bounded three ways: the coefficients are clamped to a range, the
 * multiplier is clamped, and each observation is trimmed to within a factor of the current prediction before
 * it is used, so a few stalls (a phone call, a real struggle) cannot teach the model that hard text is
 * slow. Old observations fade (FORGET), so a reader who gets faster is followed.
 *
 * Nothing here is validated against real readers. The priors, the ridge strength and the bounds are
 * provisional and are named below so they can be tuned in one place.
 */

export const R0 = 0.08;   // typical share of words outside a 5,000 to 10,000-word list in ordinary prose
export const C0 = 7;      // typical words per clause
/* Prior multiplier shape: 1.0 at ordinary text; +0.14 for every 0.10 more rare words (so text with 30%
 * rare words is expected to take about 31% longer); +3% per extra word per clause. */
export const PRIORS = Object.freeze([1.0, 1.4, 0.03]);
export const LAMBDA = 10;      // pull towards the prior, in "observations"
export const FORGET = 0.985;   // weight kept on older observations after each new one
export const BOUNDS = Object.freeze({ b0: [0.5, 2.0], b1: [0, 4], b2: [0, 0.12] });
export const MULT_RANGE = Object.freeze([0.5, 3.0]);
export const TRIM = Object.freeze([0.5, 2.0]);  // an observation counts as within this factor of the prediction

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/* x = [1, rare - R0, clause - C0]. Missing features count as ordinary (zero offset). */
export function featureVector(features) {
  const f = features || {};
  const rare = Number.isFinite(f.rareShare) ? clamp(f.rareShare, 0, 0.6) : R0;
  const clause = Number.isFinite(f.clauseLength) && f.clauseLength > 0 ? clamp(f.clauseLength, 2, 30) : C0;
  return [1, rare - R0, clause - C0];
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = m[r][c] / m[c][c];
      for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

export function createReadingTimeModel(opts = {}) {
  const prior = opts.priors || PRIORS;
  const lambda = opts.lambda ?? LAMBDA;
  const forget = opts.forget ?? FORGET;
  const reset = () => ({
    A: [[lambda, 0, 0], [0, lambda, 0], [0, 0, lambda]],
    b: prior.map((p) => lambda * p),
    n: 0,
  });
  let st = reset();
  let beta = [...prior];

  function refit() {
    const sol = solve3(st.A, st.b);
    if (!sol) { beta = [...prior]; return; }
    beta = [clamp(sol[0], ...BOUNDS.b0), clamp(sol[1], ...BOUNDS.b1), clamp(sol[2], ...BOUNDS.b2)];
  }

  /* The multiplier on the reader's ordinary pace for text with these features. */
  function multiplier(features) {
    const x = featureVector(features);
    return clamp(beta[0] * x[0] + beta[1] * x[1] + beta[2] * x[2], ...MULT_RANGE);
  }

  /* observed = (time per word) / (the reader's ordinary time per word). Returns false when ignored. */
  function update(features, observed) {
    if (!Number.isFinite(observed) || observed <= 0) return false;
    const x = featureVector(features);
    const pred = multiplier(features);
    const y = clamp(observed, pred * TRIM[0], pred * TRIM[1]);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        // The prior (the lambda on the diagonal) does not fade; only observations do.
        const prev = st.A[i][j] - (i === j ? lambda : 0);
        st.A[i][j] = (i === j ? lambda : 0) + forget * prev + x[i] * x[j];
      }
      const prevB = st.b[i] - lambda * prior[i];
      st.b[i] = lambda * prior[i] + forget * prevB + x[i] * y;
    }
    st.n += 1;
    refit();
    return true;
  }

  function serialize() { return { A: st.A, b: st.b, n: st.n }; }

  function hydrate(s) {
    const ok = s && Array.isArray(s.A) && s.A.length === 3 && s.A.every((r) => Array.isArray(r) && r.length === 3 && r.every(Number.isFinite))
      && Array.isArray(s.b) && s.b.length === 3 && s.b.every(Number.isFinite) && Number.isFinite(s.n);
    if (!ok) return false;
    st = { A: s.A.map((r) => [...r]), b: [...s.b], n: s.n };
    refit();
    return true;
  }

  return { multiplier, update, serialize, hydrate, count: () => st.n, coefficients: () => [...beta] };
}
