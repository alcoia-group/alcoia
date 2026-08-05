/* residual-distribution.js — is this paragraph unusual *for this reader*
 *
 * Fixed thresholds ("under 30% of expected is too fast") assume every reader
 * deviates from the model the same way. They don't. Someone who consistently
 * reads at 0.6x the expectation is not struggling on every paragraph — they
 * read slowly, and a fixed cutoff flags them on almost everything, which is
 * the fastest way to make the product unbearable.
 *
 * Keeping the spread of a reader's own reading-rate residuals lets the
 * question become "was this one unusual for them", which is the question
 * actually worth asking.
 *
 * Welford's method: no array to grow, no second pass, numerically stable.
 */

export class ResidualDistribution {
  constructor(minSamples = 8) {
    this._n = 0;
    this._mean = 0;
    this._m2 = 0;
    this._minSamples = minSamples;
  }

  add(ratio) {
    // Reject nonsense rather than letting it move the mean. A ratio of 200
    // means the reader left the tab open, not that they read very slowly.
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 20) return false;
    this._n += 1;
    const delta = ratio - this._mean;
    this._mean += delta / this._n;
    this._m2   += delta * (ratio - this._mean);
    return true;
  }

  ready() { return this._n >= this._minSamples; }

  stdDev() {
    if (this._n < 2) return 0;
    return Math.sqrt(this._m2 / (this._n - 1));
  }

  /* Standard deviations from this reader's own mean, or null when there is
   * not yet enough history — which is the honest answer for the first several
   * paragraphs of any session, and the caller must fall back accordingly. */
  zScore(ratio) {
    if (!this.ready()) return null;
    const sd = this.stdDev();
    if (sd < 1e-6) return null;          // no spread yet; z would be meaningless
    return (ratio - this._mean) / sd;
  }

  stats() { return { n: this._n, mean: this._mean, sd: this.stdDev() }; }
}
