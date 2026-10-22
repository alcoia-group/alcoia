/* screen-timing.js: time on a screen, for readers who move a whole screen at a time.
 *
 * Paragraph timing assumes the reader's eyes follow a reading line down the page. Someone who presses
 * Page Down or Space, or flicks a trackpad a full screen, does not: the paragraph at the reading line
 * changes in jumps, a paragraph that sat in the middle of a screen is never "entered", and the whole time
 * on a screen lands on whichever paragraph happens to be at the line. That makes a perfectly normal reader
 * look slow on one paragraph and invisible on the rest.
 *
 * This module only watches scrolling. A burst is a run of scroll events less than BURST_GAP_MS apart. A
 * burst that moves the page by at least JUMP_FRACTION of the viewport height is a jump. When most recent
 * bursts are jumps the reader is in screen mode, and the time between one jump ending and the next scroll
 * starting is the time spent on that screen. The caller works out how long that screen should have taken
 * from the paragraphs it showed. Vertical page scrolling only.
 *
 * Constants are provisional and named so they can be tuned in one place.
 */

export const SCREEN = Object.freeze({
  JUMP_FRACTION: 0.6,   // a burst this far (of the viewport height) is a screen jump
  BURST_GAP_MS: 200,    // events closer than this belong to the same burst
  HISTORY: 4,           // bursts remembered
  ENTER_JUMPS: 3,       // of the last HISTORY bursts, this many jumps put the reader in screen mode
  MIN_DWELL_MS: 1500,   // a stay shorter than this is not a read
  MAX_DWELL_MS: 300000, // a stay longer than this is the reader being elsewhere
});

export function createScreenTiming(opts = {}) {
  const now = opts.now || (() => Date.now());
  const viewportHeight = opts.viewportHeight || (() => (typeof window !== 'undefined' ? window.innerHeight : 800));

  let lastY = null;
  let burst = null;        // { startY, lastY, lastT }
  let history = [];        // booleans, true = jump
  let settled = null;      // { at, y } when the last closed burst was a jump

  function closeBurst() {
    const net = Math.abs(burst.lastY - burst.startY);
    const jump = net >= SCREEN.JUMP_FRACTION * viewportHeight();
    history.push(jump);
    if (history.length > SCREEN.HISTORY) history.shift();
    settled = jump ? { at: burst.lastT + burst.shift, y: burst.lastY } : null;
  }

  function isScreenMode() {
    return history.filter(Boolean).length >= SCREEN.ENTER_JUMPS;
  }

  /* Call on every scroll event with the current scroll position. Returns { dwellMs, settleY } when a
   * screen the reader stayed on has just ended (the first scroll after a jump), else null. */
  function noteScroll(y) {
    const t = now();
    let stay = null;
    if (burst && t - burst.lastT < SCREEN.BURST_GAP_MS) {
      burst.lastY = y;
      burst.lastT = t;
      lastY = y;
      return null;
    }
    if (burst) closeBurst();
    if (settled) {
      const dwellMs = t - settled.at;
      if (dwellMs >= SCREEN.MIN_DWELL_MS && dwellMs <= SCREEN.MAX_DWELL_MS) stay = { dwellMs, settleY: settled.y };
      settled = null;
    }
    burst = { startY: lastY == null ? y : lastY, lastY: y, lastT: t, shift: 0 };
    lastY = y;
    return stay;
  }

  /* Time the reader was away does not count as time on the screen. */
  function shiftTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (settled) settled.at += ms;
    // The last burst is only closed by the next scroll, so away time can arrive while it is still open.
    if (burst) burst.shift += ms;
  }

  function reset() { lastY = null; burst = null; history = []; settled = null; }

  return { noteScroll, isScreenMode, shiftTime, reset, stats: () => ({ history: [...history] }) };
}
