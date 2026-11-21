/* reading-line.js: where on the screen this reader actually reads
 *
 * paragraph-tracker.js decides which paragraph is being read by asking which one crosses a horizontal "reading line".
 * It starts at 40% of the window height, a bit above the middle. People differ: some read near the top, some low on
 * the screen. A wrong line means a paragraph is judged on someone else's reading time. This learns the reader's own
 * line from where they put their attention on purpose: the mouse pointer when it rests on text during a scroll, and
 * where they select text. Nothing else counts (keyboard and touch scrolling give no position, so for those readers the
 * line stays where it started).
 *
 * What is kept is a small histogram of positions as fractions of the window height (20 bins, no text, no page, no
 * time) and one number, the current line. The number follows the account (account-sync.js), the way the reading speed
 * does, so a new device does not start from scratch; the histogram stays on the device.
 *
 * The line is the median of the samples, pulled toward the starting position until there are enough of them, and kept
 * between MIN_LINE and MAX_LINE so a handful of odd samples cannot send it somewhere absurd. It is a heuristic, not a
 * measurement, and nothing here claims to know where the reader's eyes are.
 */

export const DEFAULT_LINE = 0.4;
export const MIN_LINE = 0.25;
export const MAX_LINE = 0.6;
const BINS = 20;

export function createReadingLineLearner({ prior = DEFAULT_LINE, shrink = 12, seedWeight = 30, maxWeight = 300 } = {}) {
  let bins = new Array(BINS).fill(0);
  let total = 0;

  const binOf = (f) => Math.min(BINS - 1, Math.floor(f * BINS));

  // A position as a fraction of the window height. The very top and bottom edges are chrome and gutters, not reading.
  function note(fraction, weight = 1) {
    if (!Number.isFinite(fraction) || !Number.isFinite(weight) || weight <= 0) return false;
    if (fraction < 0.05 || fraction > 0.95) return false;
    bins[binOf(fraction)] += weight;
    total += weight;
    if (total > maxWeight) { bins = bins.map((b) => b / 2); total /= 2; } // old samples fade, so a changed habit shows
    return true;
  }

  function median() {
    let acc = 0;
    const half = total / 2;
    for (let i = 0; i < BINS; i++) {
      if (acc + bins[i] >= half) {
        const into = bins[i] > 0 ? (half - acc) / bins[i] : 0.5;
        return (i + Math.min(1, Math.max(0, into))) / BINS;
      }
      acc += bins[i];
    }
    return prior;
  }

  function value() {
    if (total <= 0) return prior;
    const v = (shrink * prior + total * median()) / (shrink + total);
    return Math.round(Math.min(MAX_LINE, Math.max(MIN_LINE, v)) * 1000) / 1000;
  }

  // A value that came from the account (another device). Used only while this device has learned nothing itself.
  function seed(v) {
    if (!Number.isFinite(v) || v < MIN_LINE || v > MAX_LINE || total > 0) return false;
    bins[binOf(v)] += seedWeight;
    total += seedWeight;
    return true;
  }

  function state() { return { bins: bins.slice(), total }; }
  function load(s) {
    if (!s || !Array.isArray(s.bins) || s.bins.length !== BINS || !s.bins.every((n) => Number.isFinite(n) && n >= 0)) return false;
    bins = s.bins.slice();
    total = bins.reduce((a, b) => a + b, 0);
    return true;
  }

  return { note, value, seed, state, load, samples: () => total };
}
