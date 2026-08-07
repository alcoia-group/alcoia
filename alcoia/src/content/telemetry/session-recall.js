/* session-recall.js — what to ask about at the end
 *
 * Retrieval practice is the one intervention in this product with an actual
 * evidence base behind it, and it works best spaced away from the reading
 * rather than immediately after it. This picks which paragraphs are worth
 * asking about once a session is over.
 *
 * Selection is weighted, not ranked. Asking only about the paragraphs someone
 * struggled with turns the recall into a list of their failures and tells them
 * nothing about what they got right; asking uniformly wastes questions on
 * paragraphs they skimmed past in two seconds. So struggle raises a
 * paragraph's weight substantially without guaranteeing it a slot, and every
 * genuinely-read paragraph keeps a real chance of being picked.
 *
 * Nothing here is submitted anywhere. It produces candidates; the reader
 * chooses whether to answer them.
 */

/* A paragraph has to have been read, not passed over, to be worth asking
 * about. Two seconds is not reading. */
export const MIN_DWELL_MS = 4000;
export const MIN_WORDS = 40;

export function createSessionRecall(opts = {}) {
  const minDwellMs = opts.minDwellMs ?? MIN_DWELL_MS;
  const minWords = opts.minWords ?? MIN_WORDS;
  const random = opts.random || Math.random;

  /* paragraphKey -> { text, dwellMs, struggles, answeredCorrectly } */
  const seen = new Map();

  function keyFor(text) {
    return String(text || '').trim().slice(0, 80);
  }

  /* Call on every paragraph exit. Dwell accumulates — a reader who comes back
   * to a paragraph has spent more time on it, and that counts. */
  function recordRead(text, dwellMs) {
    const key = keyFor(text);
    if (!key) return;
    const words = String(text).trim().split(/\s+/).length;
    if (words < minWords) return;

    const entry = seen.get(key) || { text: String(text).trim(), dwellMs: 0, struggles: 0, answeredCorrectly: false };
    entry.dwellMs += Math.max(0, dwellMs || 0);
    seen.set(key, entry);
  }

  /* Call when the engine asserted `struggling` against a paragraph. */
  function recordStruggle(text) {
    const key = keyFor(text);
    const entry = seen.get(key);
    if (entry) entry.struggles += 1;
  }

  /* A paragraph the reader has already answered a question about correctly is
   * a poor use of one of the recall slots — they have demonstrated it. */
  function recordAnswered(text, correct) {
    const key = keyFor(text);
    const entry = seen.get(key);
    if (entry && correct) entry.answeredCorrectly = true;
  }

  function weightOf(entry) {
    let w = 1;
    w += Math.min(entry.struggles, 3) * 2.5;        // struggle matters, with a ceiling
    if (entry.dwellMs > minDwellMs * 4) w += 0.5;   // sustained attention
    if (entry.answeredCorrectly) w *= 0.25;          // already demonstrated
    return w;
  }

  function candidates() {
    return [...seen.values()].filter((e) => e.dwellMs >= minDwellMs);
  }

  /* Weighted sampling without replacement. Returns up to `count` paragraphs. */
  function select(count = 5) {
    const pool = candidates().map((e) => ({ entry: e, weight: weightOf(e) }));
    const picked = [];
    const n = Math.max(0, Math.min(count, pool.length));

    for (let i = 0; i < n; i++) {
      const total = pool.reduce((a, p) => a + p.weight, 0);
      if (total <= 0) break;
      let r = random() * total;
      let idx = pool.length - 1;
      for (let j = 0; j < pool.length; j++) {
        r -= pool[j].weight;
        if (r <= 0) { idx = j; break; }
      }
      picked.push(pool[idx].entry);
      pool.splice(idx, 1);
    }
    return picked;
  }

  function stats() {
    const all = [...seen.values()];
    return {
      paragraphsSeen: all.length,
      paragraphsRead: candidates().length,
      struggled: all.filter((e) => e.struggles > 0).length,
    };
  }

  return {
    recordRead, recordStruggle, recordAnswered,
    select, candidates, stats,
    reset: () => seen.clear(),
  };
}
