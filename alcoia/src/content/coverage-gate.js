/* coverage-gate.js — the one function that decides "read enough to test"
 *
 * The quiz is offered at the end of reading and is triggerable from the
 * popup, and both must read the same threshold from the same place — if
 * they diverge, the end-of-reading overlay says ready while the popup
 * button says no (the project notes, "The quiz — decided"). `evaluate()` below is
 * that one place; item 16 wires it to both surfaces and must not grow a
 * second copy of this decision.
 *
 * Gated on coverage AND dwell, never on scroll position. Coverage alone —
 * "the reader scrolled past every paragraph" — is trivially fakeable in
 * seconds and is exactly the gap receipt.js's own header already warns
 * about ("Coverage without recall says only that a page was scrolled
 * past"). Requiring a minimum measured dwell time alongside it is what
 * keeps a fast scroll-to-bottom from reading as "done".
 *
 * Gated on accumulated coverage for the DOCUMENT, not the visit: reading
 * half today and half tomorrow reaches the threshold tomorrow, the same
 * way the existing session-continuity toast survives leaving and
 * returning. It is NOT built on top of that toast's storage, though —
 * saveLastVisit()/checkLastVisit() in content.js key on
 * `window.location.href`, the *entire* URL including the query string, so
 * a `?utm_source=` appended to a shared link resets it. This module needs
 * to survive exactly that case, so it defines its own key — see
 * documentKey() — rather than inheriting one that would silently defeat
 * the "robust to query strings" requirement.
 */

const STORAGE_KEY = 'sra_doc_coverage';
// Least-recently-updated eviction once this many documents are tracked —
// the same cap shape as content.js's existing sra_last_visit (200) and
// sra_highlights (50-100 per page) stores.
const MAX_DOCS = 150;
// Per document. A paragraph fingerprint is ~80 chars; 800 of them is a very
// long article and still a small fraction of a typical storage.local quota.
const MAX_FINGERPRINTS_PER_DOC = 800;

export const DEFAULT_THRESHOLDS = Object.freeze({
  minCoveragePct: 60,
  minDwellMs: 60000, // one minute of measured reading time
});

// The one reason string shown to the reader for every not-ready case
// (the project notes: "the popup button is disabled with a stated reason ... never
// a silent no-op"). Deliberately not differentiated by cause — "why not"
// detail is available via the returned coveragePct/dwellMs for anything
// that wants it (e.g. a debug overlay), but the reader sees one sentence.
const NOT_READY_REASON = 'not enough reading tracked on this page yet';

/* Canonical per-document identity: hostname + pathname, nothing else. No
 * search (query strings), no hash (in-page jumps and most SPA router
 * state). A page that changes only its query string or its hash is the
 * same document for this purpose; a route change that actually changes the
 * pathname is a different one, and starts its own accumulation — which is
 * the correct behaviour for an SPA that swaps in a different article
 * without a full reload. */
export function documentKey(loc = (typeof window !== 'undefined' ? window.location : null)) {
  if (!loc || !loc.hostname) return null;
  return `${loc.hostname}${loc.pathname || ''}`;
}

function fingerprint(text) {
  return String(text || '').trim().slice(0, 80);
}

export function createCoverageGate(opts = {}) {
  const storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  const now = opts.now || (() => Date.now());
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };

  function storageGet(keys) {
    return new Promise((resolve) => storage.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => storage.set(obj, () => resolve()));
  }

  async function allDocs() {
    if (!storage) return {};
    return (await storageGet({ [STORAGE_KEY]: {} }))[STORAGE_KEY] || {};
  }

  /* Call once per paragraph the reader actually leaves — the same input
   * intervention-policy's recordCoverage() takes, from paragraph-tracker's
   * transition.left. Never for media landmarks: a figure was never prose,
   * so it can never count toward "read enough of this document". Re-seeing
   * a paragraph already counted (this visit or a previous one) adds no
   * further coverage, but its dwell still accrues — time spent rereading is
   * still time spent reading. `totalParagraphs` should be the prose-only
   * count (paragraphTracker.count({ excludeMedia: true })) and only ever
   * grows, since a page can lazy-load more content but rarely loses what
   * was already there. */
  async function recordProgress(key, { text, words, dwellMs, media, totalParagraphs } = {}) {
    if (!storage || !key || media) return;
    const docs = await allDocs();
    const doc = docs[key] || { fingerprints: [], wordsCovered: 0, dwellMs: 0, totalParagraphs: 0, updatedAt: 0 };

    const fp = fingerprint(text);
    if (fp && !doc.fingerprints.includes(fp)) {
      doc.fingerprints.push(fp);
      if (doc.fingerprints.length > MAX_FINGERPRINTS_PER_DOC) doc.fingerprints.shift();
      doc.wordsCovered += Number(words) || 0;
    }
    if (Number(dwellMs) > 0) doc.dwellMs += Number(dwellMs);
    if (Number.isInteger(totalParagraphs) && totalParagraphs > doc.totalParagraphs) {
      doc.totalParagraphs = totalParagraphs;
    }
    doc.updatedAt = now();
    docs[key] = doc;

    const keys = Object.keys(docs);
    if (keys.length > MAX_DOCS) {
      const oldest = keys.reduce((a, b) => (docs[a].updatedAt || 0) <= (docs[b].updatedAt || 0) ? a : b);
      delete docs[oldest];
    }

    await storageSet({ [STORAGE_KEY]: docs });
  }

  /* THE one function (see header). Returns { ready, reason, coveragePct,
   * dwellMs } — reason is always populated, ready or not, the same
   * evaluate()/reason discipline as intervention-policy.js. `unknown`
   * (document length not yet established) is treated as not-ready, never
   * as a plausible default (invariant 5). */
  async function evaluate(key) {
    const deny = (coveragePct = null, dwellMs = 0) =>
      ({ ready: false, reason: NOT_READY_REASON, coveragePct, dwellMs });

    if (!key) return deny();
    const doc = (await allDocs())[key];
    if (!doc || !doc.fingerprints.length || !doc.totalParagraphs) return deny();

    const coveragePct = Math.min(100, Math.round((doc.fingerprints.length / doc.totalParagraphs) * 1000) / 10);
    const dwellMs = doc.dwellMs;

    if (coveragePct < thresholds.minCoveragePct || dwellMs < thresholds.minDwellMs) {
      return deny(coveragePct, dwellMs);
    }
    return { ready: true, reason: `read ${coveragePct}% of the page`, coveragePct, dwellMs };
  }

  /* Per document and all at once — mirrors the delete-actually-deletes
   * promise made for the install token and (once built) the quiz record. */
  async function clear(key) {
    if (!storage) return;
    const docs = await allDocs();
    if (key) delete docs[key];
    await storageSet({ [STORAGE_KEY]: key ? docs : {} });
  }

  return { recordProgress, evaluate, clear, documentKey };
}
