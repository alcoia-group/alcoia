/* progression-entropy.js — the shape of a session, not a moment
 *
 * How dwell time is distributed across the paragraphs of a session says
 * something no single paragraph can:
 *
 *   near-uniform and tiny  → skimming the whole thing
 *   smooth and monotone    → reading it
 *   spiky                  → reading it and getting stuck in places
 *
 * Shannon entropy over the normalised dwell distribution, reported against the
 * maximum for that paragraph count so the number means the same thing on a
 * three-paragraph page and a fifty-paragraph one.
 *
 * This is a session-level measure and it belongs on the receipt. It is
 * corroboration at most — nobody should be interrupted because the shape of
 * their session looked unusual.
 */

export function createProgressionEntropy(opts = {}) {
  const now         = opts.now || (() => Date.now());
  const minParagraphs = opts.minParagraphs ?? 5;
  const skimDwellMs = opts.skimDwellMs ?? 3000;

  const dwell = new Map();   // paragraph index -> total ms
  let pending = null;

  /* Feed it paragraph_change transitions from paragraph-tracker. */
  function update(transition) {
    if (!transition || transition.type !== 'paragraph_change') return null;
    const left = transition.left;
    if (!left || !Number.isInteger(left.index) || !(left.dwellMs > 0)) return null;

    dwell.set(left.index, (dwell.get(left.index) || 0) + left.dwellMs);
    if (dwell.size < minParagraphs) return null;

    const s = stats();
    pending = {
      type: 'progression',
      assertable: false,
      entropy: s.entropy,
      normalized: s.normalized,
      meanDwellMs: s.meanDwellMs,
      subtype: s.shape,
    };
    return pending;
  }

  function stats() {
    const values = [...dwell.values()];
    const n = values.length;
    const total = values.reduce((a, b) => a + b, 0);
    if (!n || total <= 0) {
      return { paragraphs: n, entropy: 0, normalized: 0, meanDwellMs: 0, shape: 'unknown' };
    }

    let entropy = 0;
    for (const v of values) {
      const p = v / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    const max = n > 1 ? Math.log2(n) : 0;
    const normalized = max > 0 ? entropy / max : 0;
    const meanDwellMs = total / n;

    // Even attention across paragraphs, none of them held for long, is what
    // skimming looks like. Even attention with real dwell is just reading.
    let shape = 'reading';
    if (normalized > 0.95 && meanDwellMs < skimDwellMs) shape = 'skimming';
    else if (normalized < 0.75) shape = 'uneven';

    return { paragraphs: n, entropy, normalized, meanDwellMs, shape };
  }

  function signal() { const s = pending; pending = null; return s; }

  return { update, signal, stats, reset() { dwell.clear(); pending = null; } };
}
