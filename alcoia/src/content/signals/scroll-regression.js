/* scroll-regression.js — going back to re-read, and what it means when they stay
 *
 * Replaces gaze-features' line_reread_count, which bands raw viewport y by 20px
 * with no scroll offset and therefore counts scrolling as re-reading. Paragraph
 * indices come from paragraph-tracker and do not move when the page does.
 *
 * "Regressions during reading: The cost depends on the cause" (Psychonomic
 * Bulletin & Review, 2016) distinguishes a low-level oculomotor correction
 * from a regression made to repair a comprehension breakdown — only the
 * latter is diagnostic, and raw backtracking counts are noisy without that
 * distinction. A correction is typically a small backward jump followed by
 * immediate forward continuation; a genuine re-read is a larger jump followed
 * by real dwell at the earlier point — comparable to or exceeding how long
 * the reader spent there the first time — before moving on again. Only the
 * latter is ever emitted here; a correction stays invisible, exactly as it is
 * for a fluent human reader. That verdict cannot be known at the moment of
 * the backward jump — only once the reader leaves the paragraph again is
 * their dwell there actually known — so a jump is watched, not counted,
 * until the transition that resolves it arrives.
 *
 * The latency signature (how long ago they left before jumping back) is
 * still the part that separates competent consolidation from mid-thought
 * loss, unchanged from before: a fast return is still in trouble, a slow one
 * has finished a thought and gone back to check, which is competent reading
 * and was never struggle evidence — so it is exempt from the genuine/
 * correction distinction above and still emits immediately.
 *
 * A reader who keeps genuinely re-reading the SAME passage is repetition
 * this module counts (sameIndexRereadCount) — the signature state-engine.js
 * reads as evidence for the confusion substate specifically: they keep
 * trying to resolve something, not overloaded, not disengaged.
 */

export const FAST_RETURN_MS = 2000;
export const SLOW_RETURN_MS = 10000;

export function createScrollRegressionDetector(opts = {}) {
  const now              = opts.now || (() => Date.now());
  const minDistance      = opts.minDistance ?? 1;      // paragraphs — any backward move worth watching at all
  // Below this, a jump is "small" and never counts as a genuine re-read,
  // however long the reader lingers once back — judgement calls, not
  // measured from the cited research, which describes the two signatures
  // qualitatively rather than with a paragraph-count cutoff.
  const largeDistance    = opts.largeDistance ?? 2;    // paragraphs
  const rereadDwellRatio = opts.rereadDwellRatio ?? 0.6;
  const cooldownMs       = opts.cooldown ?? 20000;

  let maxIndexReached    = -1;
  let lastLeftAt         = new Map();   // paragraph index -> when the reader last left it (latency to a jump back)
  let firstDwellByIndex  = new Map();   // paragraph index -> dwell on the reader's first visit, the "original pace" a return is judged against
  let rereadCountByIndex = new Map();   // paragraph index -> how many genuine re-reads have resolved here this session
  let pendingJump        = null;        // a backward jump under evaluation, not yet known to be a correction or a re-read
  let pending            = null;
  let lastEmitAt         = 0;
  let regressionCount    = 0;

  /* A jump under evaluation is resolved once the reader leaves the paragraph
   * they jumped back to — paragraph-tracker's `left` on the next transition
   * is always the prior `active`, so this is always the very next call. */
  function resolveJump(left, t) {
    const jump = pendingJump;
    pendingJump = null;

    const returnDwellMs   = left.dwellMs;
    const originalDwellMs = firstDwellByIndex.get(jump.toIndex);

    // No baseline to compare against (the paragraph was never actually left
    // before, so there is no "original pace" for this reader on it), or the
    // jump was small, or the return didn't come close to how long they spent
    // there the first time: a quick, oculomotor-style correction, or simply
    // ambiguous. Per the cited research only a genuine re-read loop is
    // diagnostic — this stays invisible rather than being forced into a
    // category on partial evidence.
    const isGenuine = jump.distance >= largeDistance
      && originalDwellMs != null && originalDwellMs > 0
      && returnDwellMs != null
      && returnDwellMs >= originalDwellMs * rereadDwellRatio;

    if (!isGenuine) return null;

    const rereadCount = (rereadCountByIndex.get(jump.toIndex) || 0) + 1;
    rereadCountByIndex.set(jump.toIndex, rereadCount);

    lastEmitAt = t;
    regressionCount += 1;
    pending = {
      type: 'regression',
      subtype: jump.subtype,
      toIndex: jump.toIndex,
      fromIndex: jump.fromIndex,
      distance: jump.distance,
      latencyMs: jump.latencyMs,
      returnDwellMs,
      originalDwellMs,
      // Repeated genuine re-reads of the SAME passage, not just this one —
      // state-engine.js's evidence for the confusion substate specifically.
      sameIndexRereadCount: rereadCount,
      el: jump.el,
    };
    return pending;
  }

  /* Feed it paragraph_change transitions from paragraph-tracker. */
  function update(transition) {
    if (!transition || transition.type !== 'paragraph_change') return null;

    const { left, entered } = transition;
    const t = transition.at ?? now();

    let resolved = null;
    if (pendingJump && left && left.index === pendingJump.toIndex) {
      resolved = resolveJump(left, t);
    }

    if (left && Number.isInteger(left.index)) {
      // The FIRST time this paragraph is ever left, not overwritten by a
      // later re-visit — this is the "original pace" every future return is
      // judged against.
      if (!firstDwellByIndex.has(left.index)) firstDwellByIndex.set(left.index, left.dwellMs);
      lastLeftAt.set(left.index, t);
      if (left.index > maxIndexReached) maxIndexReached = left.index;
    }
    if (!entered || !Number.isInteger(entered.index)) return resolved;
    if (entered.index > maxIndexReached) maxIndexReached = entered.index;

    const distance = maxIndexReached - entered.index;
    if (distance < minDistance) return resolved;          // moving forward, or holding
    if (t - lastEmitAt < cooldownMs) return resolved;

    const leftAt    = lastLeftAt.get(entered.index);
    const latencyMs = leftAt != null ? t - leftAt : null;

    let subtype = 'return';
    if (latencyMs != null && latencyMs <= FAST_RETURN_MS)      subtype = 'fast_return';
    else if (latencyMs != null && latencyMs >= SLOW_RETURN_MS) subtype = 'slow_return';

    // A slow, deliberate return already resolves to on_pace downstream and
    // was never struggle evidence — the genuine-re-read-vs-correction
    // distinction exists only to gate struggle evidence, so it does not
    // apply here. Emits immediately, exactly as before this module drew
    // that distinction at all.
    if (subtype === 'slow_return') {
      lastEmitAt = t;
      regressionCount += 1;
      pending = {
        type: 'regression', subtype, toIndex: entered.index, fromIndex: maxIndexReached,
        distance, latencyMs, el: entered.el || null,
      };
      return pending;
    }

    // fast_return / return: watched, not counted yet. A jump that continues
    // forward again almost immediately must stay invisible, exactly as it is
    // for a fluent human reader — this only becomes struggle evidence once
    // resolveJump() knows whether the reader actually re-read it.
    pendingJump = { toIndex: entered.index, fromIndex: maxIndexReached, distance, subtype, latencyMs, el: entered.el || null };
    return resolved;
  }

  function signal() { const s = pending; pending = null; return s; }

  return {
    update,
    signal,
    stats: () => ({ maxIndexReached, regressions: regressionCount }),
    reset() {
      maxIndexReached = -1;
      lastLeftAt = new Map();
      firstDwellByIndex = new Map();
      rereadCountByIndex = new Map();
      pendingJump = null;
      pending = null;
      lastEmitAt = 0;
      regressionCount = 0;
    },
  };
}
