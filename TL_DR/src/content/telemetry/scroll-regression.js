/* scroll-regression.js — going back to re-read, and what the delay means
 *
 * Replaces gaze-features' line_reread_count, which bands raw viewport y by 20px
 * with no scroll offset and therefore counts scrolling as re-reading. Paragraph
 * indices come from paragraph-tracker and do not move when the page does.
 *
 * The latency signature is the part worth having. A reader who returns within
 * a couple of seconds lost the thread mid-sentence and is still in trouble. A
 * reader who returns after ten seconds or more has finished a thought and gone
 * back to consolidate, which is competent reading and must not be interrupted.
 * Same movement, opposite meanings.
 */

export const FAST_RETURN_MS = 2000;
export const SLOW_RETURN_MS = 10000;

export function createScrollRegressionDetector(opts = {}) {
  const now         = opts.now || (() => Date.now());
  const minDistance = opts.minDistance ?? 1;   // paragraphs
  const cooldownMs  = opts.cooldown ?? 20000;

  let maxIndexReached = -1;
  let lastLeftAt      = new Map();   // paragraph index -> when the reader last left it
  let pending         = null;
  let lastEmitAt      = 0;

  /* Feed it paragraph_change transitions from paragraph-tracker. */
  function update(transition) {
    if (!transition || transition.type !== 'paragraph_change') return null;

    const { left, entered } = transition;
    const t = transition.at ?? now();

    if (left && Number.isInteger(left.index)) {
      lastLeftAt.set(left.index, t);
      if (left.index > maxIndexReached) maxIndexReached = left.index;
    }
    if (!entered || !Number.isInteger(entered.index)) return null;
    if (entered.index > maxIndexReached) maxIndexReached = entered.index;

    const distance = maxIndexReached - entered.index;
    if (distance < minDistance) return null;          // moving forward, or holding

    if (t - lastEmitAt < cooldownMs) return null;

    const leftAt    = lastLeftAt.get(entered.index);
    const latencyMs = leftAt != null ? t - leftAt : null;

    let subtype = 'return';
    if (latencyMs != null && latencyMs <= FAST_RETURN_MS)      subtype = 'fast_return';
    else if (latencyMs != null && latencyMs >= SLOW_RETURN_MS) subtype = 'slow_return';

    lastEmitAt = t;
    pending = {
      type: 'regression',
      subtype,
      toIndex: entered.index,
      fromIndex: maxIndexReached,
      distance,
      latencyMs,
      el: entered.el || null,
    };
    return pending;
  }

  function signal() { const s = pending; pending = null; return s; }

  return {
    update,
    signal,
    stats: () => ({ maxIndexReached }),
    reset() { maxIndexReached = -1; lastLeftAt = new Map(); pending = null; lastEmitAt = 0; },
  };
}
