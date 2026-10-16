/* decision-log.js — a short, local-only record of WHY the extension did or did not interrupt
 *
 * Same promises as diag-log.js: on the device only, capped, never transmitted, cleared in one click from the
 * diagnostics page. Entries are a fixed shape of short internal tags and rounded numbers. It must never be handed
 * passage text, a page title, a page URL, a paragraph key or a question: callers pass only the detector's label,
 * its confidence, which kind of evidence it rested on, and the policy's own reason string.
 *
 * What it is for: judging the detector and the policy from the reader's own history, locally. summarize() turns the
 * entries into rates a person can read. Those rates are PROXIES, not accuracy: a dismissed question does not prove
 * the reader was not struggling, and a self-report made while the detector said "on pace" does not prove the
 * detector missed it. They say how often the tool interrupted, how often that was turned away, and how often the
 * reader said something the detector had not noticed. No accuracy figure is, or may be, derived from them.
 */

const STORAGE_KEY = 'sra_decision_log';
const MAX_ENTRIES = 300;
const KINDS = new Set(['decision', 'shown', 'answered', 'dismissed', 'self_report']);
const URL_PATTERN = /https?:\/\/\S+/gi;
const tag = (v, n = 40) => (v == null ? null : String(v).replace(URL_PATTERN, '').slice(0, n));
const round2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export function sanitizeEntry(e, now) {
  if (!e || !KINDS.has(e.kind)) return null;
  return {
    at: now,
    kind: e.kind,
    state: tag(e.state),
    confidence: round2(e.confidence),
    basis: tag(e.basis, 20),
    action: tag(e.action, 20),
    policyAction: tag(e.policyAction, 20),
    cardType: tag(e.cardType, 20), // which kind of card (ask, explain, repair, retention, probe, return_check, focus, ...)
    reason: tag(e.reason, 80),
    previousState: tag(e.previousState),
  };
}

export function createDecisionLog(opts = {}) {
  const storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  const now = opts.now || (() => Date.now());
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const get = (keys) => new Promise((resolve) => storage.get(keys, resolve));
  const set = (obj) => new Promise((resolve) => storage.set(obj, () => resolve()));
  let chain = Promise.resolve(); // writes are serialised so two quick events do not overwrite each other

  /* Never throws: logging must not become a new failure on a reading path. */
  function record(entry) {
    if (!storage) return Promise.resolve();
    const clean = sanitizeEntry(entry, now());
    if (!clean) return Promise.resolve();
    chain = chain.then(async () => {
      try {
        const existing = (await get({ [STORAGE_KEY]: [] }))[STORAGE_KEY] || [];
        await set({ [STORAGE_KEY]: [clean, ...existing].slice(0, maxEntries) });
      } catch (e) { /* not worth logging */ }
    });
    return chain;
  }
  async function list() {
    if (!storage) return [];
    return (await get({ [STORAGE_KEY]: [] }))[STORAGE_KEY] || [];
  }
  async function clear() {
    if (!storage) return;
    chain = chain.then(() => set({ [STORAGE_KEY]: [] }));
    await chain;
  }
  return { record, list, clear };
}

const ratio = (n, d) => (d > 0 ? Math.round((n / d) * 100) / 100 : null);
const WITHHELD_REASON = /budget|cooldown|already|backoff|dismiss|visible|abstain|snooze/i;

/* Proxies from local entries (newest first or any order). Every rate carries its denominator so a reader of the
 * page can see how little a small sample says. */
export function summarizeDecisions(entries = []) {
  const by = (k) => entries.filter((e) => e.kind === k);
  const decisions = by('decision');
  const allowed = decisions.filter((d) => d.action && d.action !== 'hold');
  const withheld = decisions.filter((d) => d.action === 'hold');
  const shown = by('shown');
  const answered = by('answered');
  const dismissed = by('dismissed');
  const selfReports = by('self_report');
  const missedBefore = selfReports.filter((s) => !s.previousState || ['on_pace', 'skimming', 'unknown'].includes(s.previousState));

  // Dismissal rate by what the detection rested on, so the cold-start effect is visible rather than assumed.
  const basisRates = {};
  for (const basis of ['generic', 'personal_ratio', 'personal_z']) {
    const s = shown.filter((e) => e.basis === basis).length;
    const d = dismissed.filter((e) => e.basis === basis).length;
    if (s > 0) basisRates[basis] = { shown: s, dismissed: d, dismissRate: ratio(d, s) };
  }
  // Which kinds of card get turned away. Counted from the shown/answered/dismissed entries' cardType, so it works for
  // every card, not only the ones the detector triggered.
  const cardRates = {};
  for (const e of entries) {
    if (!e.cardType || !['shown', 'answered', 'dismissed'].includes(e.kind)) continue;
    const r = (cardRates[e.cardType] ||= { shown: 0, answered: 0, dismissed: 0 });
    r[e.kind] += 1;
  }
  for (const r of Object.values(cardRates)) r.dismissRate = ratio(r.dismissed, r.shown);
  return {
    decisionsLogged: decisions.length,
    allowed: allowed.length,
    withheld: withheld.length,
    withheldByPolicyRule: withheld.filter((d) => WITHHELD_REASON.test(d.reason || '')).length, // interruptions justified by signals but held back
    shown: shown.length,
    answered: answered.length,
    dismissed: dismissed.length,
    dismissRate: ratio(dismissed.length, shown.length), // interruption-cost proxy
    selfReports: selfReports.length,
    selfReportsWhileDetectorQuiet: missedBefore.length, // missed-detection proxy
    selfReportsWhileDetectorQuietRate: ratio(missedBefore.length, selfReports.length),
    byBasis: basisRates,
    byCardType: cardRates,
    note: 'Proxies from this device only, not accuracy. A dismissal or a self-report does not show what the reader needed.',
  };
}
