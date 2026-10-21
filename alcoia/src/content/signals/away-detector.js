/* away-detector.js — passive "away from the page" detection
 *
 * Away means the reader is not at the page: the tab has been hidden or the
 * window has lost focus, or nothing has been touched for a long time, with no
 * input in between. It says nothing about reading. People step away for
 * innocent reasons (a call, a kettle, another window), so away is never a
 * struggle signal, never produces an outcome, and never accuses.
 *
 * What it is for: time away must not count as reading time. When away ends it
 * reports how long it lasted, so the dwell and pace timers can be moved
 * forward by that amount and neither the paragraph's dwell nor the personal
 * pace baseline is inflated.
 *
 * Pure and clock-injected. It reads nothing from the page and sends nothing
 * anywhere. Input is only noted as "something happened", never what.
 *
 * All thresholds are provisional placeholders, not measured values.
 */

/* Hidden or unfocused, with no input since, for this long. */
export const AWAY_HIDDEN_MS = 60 * 1000;
/* Visible and focused, but nothing touched for this long. Longer than the
 * hidden case because a reader can legitimately study one paragraph for a
 * while without moving the mouse. */
export const AWAY_IDLE_MS = 10 * 60 * 1000;

export function createAwayDetector(opts = {}) {
  const now      = opts.now || (() => Date.now());
  const hiddenMs = opts.hiddenMs ?? AWAY_HIDDEN_MS;
  const idleMs   = opts.idleMs ?? AWAY_IDLE_MS;

  let lastInputAt = now();
  let hidden = false;
  let blurred = false;
  let unfocusedSince = null;
  let awaySince = null;

  const unfocused = () => hidden || blurred;

  /* The moment the reader last demonstrably was here. */
  function reference() {
    return unfocused() ? Math.max(unfocusedSince ?? 0, lastInputAt) : lastInputAt;
  }
  const crossed = (t) => t - reference() >= (unfocused() ? hiddenMs : idleMs);

  function markUnfocused(t) { if (unfocusedSince == null) unfocusedSince = t; }
  function clearIfFocused() { if (!unfocused()) unfocusedSince = null; }

  /* Decide whether away has begun or ended as of now. Returns a transition or null. */
  function evaluate() {
    const t = now();
    if (awaySince == null) {
      if (crossed(t)) {
        awaySince = reference();
        return { type: 'away_start', since: awaySince };
      }
      return null;
    }
    if (!crossed(t)) {
      const since = awaySince;
      awaySince = null;
      return { type: 'away_end', since, awayMs: Math.max(0, t - since) };
    }
    return null;
  }

  /* kind: 'hidden' | 'visible' | 'blur' | 'focus' | 'input'.
   * A return event first checks whether the threshold had already passed while
   * no timer ran (background tabs throttle timers), then applies the event. */
  function event(kind) {
    const t = now();
    const before = evaluate();
    if (kind === 'hidden')  { markUnfocused(t); hidden = true; }
    else if (kind === 'blur')    { markUnfocused(t); blurred = true; }
    else if (kind === 'visible') { hidden = false; lastInputAt = t; clearIfFocused(); }
    else if (kind === 'focus')   { blurred = false; lastInputAt = t; clearIfFocused(); }
    else if (kind === 'input')   { lastInputAt = t; }
    const after = evaluate();
    // Report the most informative of the two: an end beats a start, since
    // both can happen in one event when the reader returns after a long gap.
    if (after && after.type === 'away_end') return after;
    return after || before;
  }

  /* For the periodic tick. */
  function poll() { return evaluate(); }

  return {
    event, poll,
    isAway: () => awaySince != null,
    reset() { lastInputAt = now(); hidden = false; blurred = false; unfocusedSince = null; awaySince = null; },
  };
}
