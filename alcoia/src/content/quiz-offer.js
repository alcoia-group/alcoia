/* quiz-offer.js — end-of-reading trigger for the *unprompted* quiz offer
 *
 * Separate from coverage-gate.js on purpose: coverage-gate.js's evaluate()
 * answers "has enough of this document been read", and is shared by every
 * caller that needs that answer — this file, the popup's quiz button, and
 * eventually the quiz page itself, all read the same threshold from that
 * one function so they cannot disagree (the project notes, "The quiz — decided").
 *
 * This file answers a narrower, second question specific to the unprompted
 * card: has the reader scrolled to the end, and has this document already
 * had its one offer. Reader-initiated paths (the popup button) never call
 * this — the project notes: "The end-of-page offer is shown at most once per
 * document and is dismissible" is a rule about the offer, not about the
 * quiz itself, and the popup button has no such limit.
 *
 * Reader-initiated, so it spends no interruption budget: this module never
 * touches intervention-policy.js, and the offer it triggers is not a
 * question — nothing here calls response-signals.js either.
 */

const STORAGE_KEY = 'sra_quiz_offer_seen';
const MAX_DOCS = 150; // same cap shape as coverage-gate.js / sra_last_visit
const DEFAULT_BOTTOM_MARGIN_PX = 200;

export function isNearBottom(scrollY, viewportHeight, docHeight, marginPx = DEFAULT_BOTTOM_MARGIN_PX) {
  return docHeight > 0 && scrollY + viewportHeight >= docHeight - marginPx;
}

export function createQuizOfferChecker(opts = {}) {
  const storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  const now = opts.now || (() => Date.now());
  const coverageGate = opts.coverageGate;
  const documentKey = opts.documentKey || (() => null);
  const onEligible = opts.onEligible || (() => {});
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const marginPx = opts.bottomMarginPx ?? DEFAULT_BOTTOM_MARGIN_PX;

  function storageGet(keys) { return new Promise((resolve) => storage.get(keys, resolve)); }
  function storageSet(obj) { return new Promise((resolve) => storage.set(obj, () => resolve())); }

  let inFlight = false;

  /* Call from anywhere reading position might have changed — a scroll
   * handler, the idle tick. Cheap to call often: every branch before the
   * first `await` is synchronous, so a call that isn't near the bottom
   * never touches storage or coverage-gate.js at all. */
  async function check() {
    if (inFlight || !storage || !coverageGate || !win || !doc) return;
    if (!isNearBottom(win.scrollY, win.innerHeight, doc.documentElement.scrollHeight, marginPx)) return;
    const key = documentKey();
    if (!key) return;

    inFlight = true;
    try {
      const seen = (await storageGet({ [STORAGE_KEY]: {} }))[STORAGE_KEY] || {};
      if (seen[key]) return;

      const result = await coverageGate.evaluate(key);
      if (!result.ready) return;

      seen[key] = now();
      const keys = Object.keys(seen);
      if (keys.length > MAX_DOCS) {
        const oldest = keys.reduce((a, b) => (seen[a] || 0) <= (seen[b] || 0) ? a : b);
        delete seen[oldest];
      }
      await storageSet({ [STORAGE_KEY]: seen });

      onEligible({ ...result, key });
    } finally {
      inFlight = false;
    }
  }

  /* For tests and for a future "undo a dismissal" control — not wired to
   * any UI yet, kept symmetrical with coverage-gate.js's clear(). */
  async function hasBeenOffered(key) {
    if (!storage || !key) return false;
    const seen = (await storageGet({ [STORAGE_KEY]: {} }))[STORAGE_KEY] || {};
    return !!seen[key];
  }

  return { check, hasBeenOffered };
}
