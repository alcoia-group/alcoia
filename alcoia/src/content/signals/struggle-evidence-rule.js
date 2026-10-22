/* struggle-evidence-rule.js: one slow paragraph is not enough to call struggle.
 *
 * Reading slowly through one paragraph has plenty of innocent causes: it was dense but fine, the reader
 * stopped to think about something else, they were interrupted. A question asked on that alone interrupts
 * people who were doing nothing wrong. So a "too slow" signal is held, not passed to the state engine,
 * until a second, independent piece of evidence arrives within WINDOW_MS:
 *
 *   rule "slow_then_reread":  a genuine re-read (scroll-regression's confirmed return, not a slow return)
 *   rule "two_slow_in_a_row": another too-slow paragraph (a different one)
 *
 * Everything else passes through untouched: a self-report, a backtrack, and a confirmed re-read on its own
 * (the regression detector has its own confirmation). A held signal that is never corroborated is simply
 * dropped. Nothing is stored beyond the one held signal, and nothing leaves the page.
 *
 * The window and the rule names are provisional and can be tuned here, in one place. Turn the whole rule
 * off with { enabled: false }.
 */

export const STRUGGLE_EVIDENCE = Object.freeze({
  name: 'two_evidence_before_struggle',
  WINDOW_MS: 120000,
  SLOW_THEN_REREAD: 'slow_then_reread',
  TWO_SLOW_IN_A_ROW: 'two_slow_in_a_row',
});

const isSlow = (s) => s && s.type === 'speed_mismatch' && s.subtype === 'too_slow';
const isGenuineReread = (s) => s && s.type === 'regression' && s.subtype !== 'slow_return';

export function createStruggleEvidenceRule(opts = {}) {
  const now = opts.now || (() => Date.now());
  const windowMs = opts.windowMs ?? STRUGGLE_EVIDENCE.WINDOW_MS;
  const enabled = opts.enabled !== false;
  let held = null; // { sig, at }

  const fresh = () => held && now() - held.at <= windowMs;

  /* Takes a batch of signals, returns the ones that may reach the state engine. */
  function filter(batch) {
    const list = Array.isArray(batch) ? batch.filter(Boolean) : [];
    if (!enabled) return list;
    if (held && !fresh()) held = null;

    const out = [];
    // Slow paragraphs first, so a slow paragraph and the re-read it prompted can arrive in one batch.
    for (const sig of list) {
      if (!isSlow(sig)) continue;
      if (fresh() && sig.el !== held.sig.el) {
        out.push({ ...sig, corroboratedBy: STRUGGLE_EVIDENCE.TWO_SLOW_IN_A_ROW });
      }
      held = { sig, at: now() };
    }
    for (const sig of list) {
      if (isSlow(sig)) continue;
      if (isGenuineReread(sig) && fresh()) {
        out.push({ ...held.sig, corroboratedBy: STRUGGLE_EVIDENCE.SLOW_THEN_REREAD });
        held = null;
      }
      out.push(sig);
    }
    return out;
  }

  return { filter, hasHeld: () => !!fresh(), clear() { held = null; } };
}
