/* pool-counters.js: anonymous daily counters for product-level questions (how often does generation fail, which card
 * types are turned away). A metric, a dimension from a closed list and a number: no account, no page, no text, and
 * nothing that links a count to a person. Sent through the install-token path, like every other anonymous call.
 *
 * The SERVER decides whether the pool is on (GET statusUrl -> { enabled }). While it is off, or if the status cannot
 * be read, nothing is sent and nothing is kept beyond a short in-memory tally. The status is cached for a day.
 * Never throws; a failure just means the counts are sent later or not at all. */
const PENDING_KEY = 'sra_pool_pending';
const STATUS_KEY = 'sra_pool_status';
const DAY = 86400000;
export const METRICS = ['generation_failure', 'card_shown', 'card_answered', 'card_dismissed', 'card_quick_dismissed', 'style_shown', 'style_helped', 'style_not_helped', 'card_held_back', 'transfer_result'];

export function createPoolReporter(opts = {}) {
  const callBackend = opts.callBackend; // (action, url, body) => { ok, data }
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const statusUrl = opts.statusUrl;
  const countersUrl = opts.countersUrl;
  const now = opts.now || (() => Date.now());
  const storage = opts.storage === undefined ? (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null) : opts.storage;
  const maxRows = opts.maxRows ?? 40;

  const pending = new Map();
  const sget = (k) => new Promise((resolve) => storage.get({ [k]: null }, (r) => resolve(r[k])));
  const sset = (o) => new Promise((resolve) => storage.set(o, () => resolve()));
  let flushing = null;

  function merge(metric, dimension, value) {
    if (!METRICS.includes(metric) || typeof dimension !== 'string' || !dimension || !Number.isInteger(value) || value <= 0) return;
    const k = `${metric}|${dimension}`;
    const cur = pending.get(k) || { metric, dimension, value: 0 };
    cur.value += value;
    pending.set(k, cur);
    if (pending.size > maxRows) pending.delete(pending.keys().next().value);
  }
  // Counts left over from an earlier page are read ONCE, before anything is added or sent, so nothing is counted twice.
  async function loadPending() {
    if (!storage) return;
    try {
      const saved = await sget(PENDING_KEY);
      if (Array.isArray(saved)) for (const r of saved) merge(r.metric, r.dimension, r.value);
    } catch (e) { /* nothing saved */ }
  }
  const ready = loadPending();
  function add(metric, dimension, value = 1) {
    ready.then(() => {
      merge(metric, dimension, value);
      if (storage) return sset({ [PENDING_KEY]: [...pending.values()] });
    }).catch(() => {});
  }

  async function enabled() {
    try {
      if (storage) {
        const cached = await sget(STATUS_KEY);
        if (cached && typeof cached.enabled === 'boolean' && now() - cached.checkedAt < DAY) return cached.enabled;
      }
      if (!statusUrl || !fetchImpl) return false;
      const resp = await fetchImpl(statusUrl, { method: 'GET' });
      if (!resp.ok) return false;
      const data = await resp.json().catch(() => null);
      const on = Boolean(data && data.enabled === true);
      if (storage) await sset({ [STATUS_KEY]: { enabled: on, checkedAt: now() } });
      return on;
    } catch (e) { return false; }
  }

  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        await ready;
        if (!pending.size) return false;
        if (!(await enabled())) {
          pending.clear(); // the pool is off: nothing is kept for later
          if (storage) await sset({ [PENDING_KEY]: [] });
          return false;
        }
        if (!callBackend || !countersUrl) return false;
        const batch = [...pending.values()].map((r) => ({ ...r }));
        const resp = await callBackend('apiPost', countersUrl, { counters: batch });
        if (!resp || !resp.ok) return false;
        for (const b of batch) {
          const cur = pending.get(`${b.metric}|${b.dimension}`);
          if (!cur) continue;
          cur.value -= b.value;
          if (cur.value <= 0) pending.delete(`${b.metric}|${b.dimension}`);
        }
        if (storage) await sset({ [PENDING_KEY]: [...pending.values()] });
        return true;
      } catch (e) { return false; } finally { flushing = null; }
    })();
    return flushing;
  }

  return { add, flush, enabled, pendingCount: () => pending.size, ready };
}
