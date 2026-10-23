/* policy-profile.js: the learner's OWN adaptive profile, kept on their account so it follows them across devices.
 *
 *   GET  {profileUrl}  -> { cards: {type: {n, cooldownFactor, withhold}}, detectors: {key: {n, confidenceFactor}}, sensitivity, styles: {mode: [{style, n, trials, rate}]} }
 *   POST {eventsUrl}   { events: [{ scope: 'card'|'detector'|'style', key, shown, answered, dismissed, quickDismissed, correct, selfReports, helped, notHelped, helpedInferred, notHelpedInferred }] }
 *   (helpedInferred / notHelpedInferred: style scope only; a result inferred from a later transfer check when the reader gave no tap)
 *
 * The extension only REPORTS counts (what it showed, what the reader answered, turned away, or said it had missed) and
 * READS the adaptation the server derives from them. There is exactly one rule for what the counts mean and it lives on
 * the server, so every device gets the same answer. Counts only: no page, text, time or paragraph ever goes in.
 *
 * Needs a signed-in account with account-based learning on. Without one, load() resolves null and nothing is sent: the
 * policy then behaves as it always did (its own fixed starting values). Pending counts are kept in storage until they
 * are sent, so closing a tab does not lose them. Never throws: this must not become a failure on a reading path. */
const PENDING_KEY = 'sra_policy_pending';
const NUM = ['shown', 'answered', 'dismissed', 'quickDismissed', 'correct', 'selfReports', 'helped', 'notHelped', 'helpedInferred', 'notHelpedInferred'];
export const EMPTY_PROFILE = Object.freeze({ cards: {}, detectors: {}, sensitivity: 1, styles: {} });

export function createPolicyProfileManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const profileUrl = opts.profileUrl;
  const eventsUrl = opts.eventsUrl;
  const storage = opts.storage === undefined ? (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null) : opts.storage;
  const onChange = opts.onChange || (() => {});
  const maxPending = opts.maxPending ?? 80;

  let profile = EMPTY_PROFILE;
  let pending = new Map();
  let flushing = null;

  const sget = (k) => new Promise((resolve) => storage.get({ [k]: null }, (r) => resolve(r[k])));
  const sset = (o) => new Promise((resolve) => storage.set(o, () => resolve()));

  // Counts left over from an earlier page are read ONCE, before anything is recorded or sent, so nothing is counted twice.
  async function loadPending() {
    if (!storage) return;
    try {
      const saved = await sget(PENDING_KEY);
      if (Array.isArray(saved)) for (const e of saved) merge(e);
    } catch (e) { /* nothing saved */ }
  }
  const ready = loadPending();
  function merge(e) {
    if (!e || (e.scope !== 'card' && e.scope !== 'detector' && e.scope !== 'style') || typeof e.key !== 'string' || !e.key) return;
    const id = `${e.scope}|${e.key}`;
    const cur = pending.get(id) || { scope: e.scope, key: e.key, shown: 0, answered: 0, dismissed: 0, quickDismissed: 0, correct: 0, selfReports: 0, helped: 0, notHelped: 0, helpedInferred: 0, notHelpedInferred: 0 };
    for (const f of NUM) if (Number.isInteger(e[f]) && e[f] > 0) cur[f] += e[f];
    pending.set(id, cur);
    if (pending.size > maxPending) pending.delete(pending.keys().next().value);
  }
  function persist() {
    if (!storage) return Promise.resolve();
    return sset({ [PENDING_KEY]: [...pending.values()] }).catch(() => {});
  }

  /* Adds counts. Cheap and synchronous from the caller's side; sent later by flush(). */
  function record(event) {
    ready.then(() => { merge(event); return persist(); }).catch(() => {});
  }

  async function authHeaders() {
    const session = await getSession?.();
    if (!session || typeof session.token !== 'string' || !session.token) return null;
    return { Authorization: `Bearer ${session.token}` };
  }

  async function load() {
    try {
      const headers = await authHeaders();
      if (!headers || !profileUrl || !fetchImpl) return null;
      const resp = await fetchImpl(profileUrl, { method: 'GET', headers });
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => null);
      if (!data || typeof data !== 'object') return null;
      profile = {
        cards: data.cards && typeof data.cards === 'object' ? data.cards : {},
        detectors: data.detectors && typeof data.detectors === 'object' ? data.detectors : {},
        sensitivity: Number.isFinite(data.sensitivity) ? data.sensitivity : 1,
        styles: data.styles && typeof data.styles === 'object' ? data.styles : {},
      };
      onChange(profile);
      return profile;
    } catch (e) { return null; }
  }

  /* Sends what is pending, then refreshes the profile so the next decision uses it. Pending counts that could not be
   * sent stay pending. One flush at a time. */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        await ready;
        if (!pending.size) return false;
        const headers = await authHeaders();
        if (!headers || !eventsUrl || !fetchImpl) return false;
        const batch = [...pending.values()].map((r) => ({ ...r }));
        const resp = await fetchImpl(eventsUrl, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
        });
        if (!resp.ok) return false;
        for (const e of batch) {
          const cur = pending.get(`${e.scope}|${e.key}`);
          if (!cur) continue;
          for (const f of NUM) cur[f] = Math.max(0, cur[f] - e[f]);
          if (NUM.every((f) => cur[f] === 0)) pending.delete(`${e.scope}|${e.key}`);
        }
        await persist();
        await load();
        return true;
      } catch (e) { return false; } finally { flushing = null; }
    })();
    return flushing;
  }

  return { load, record, flush, getProfile: () => profile, pendingCount: () => pending.size, ready };
}
