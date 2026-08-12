/* diag-log.js — a short, local-only record of what silently failed
 *
 * Every failure in this extension degrades to silence for the reader
 * (invariant 9) — no error toast, no broken card, just nothing happening.
 * That is correct for the reading experience, but it means a reader whose
 * AI calls are quietly failing (a stale token, a network block, a server
 * outage) has no way to tell "nothing to interrupt about" apart from
 * "something is broken" — and neither does whoever is helping them. The
 * diagnostics page (src/popup/diagnostics.html) is the one place that
 * silence becomes visible again, on request.
 *
 * Deliberately not a general-purpose logger: entries are a fixed
 * {at, context, message} shape, context is a short internal tag
 * ('summarize' | 'apiPost' | ...), and message is sanitised — any
 * http(s) URL is stripped before it is ever written to storage. This file
 * must never be handed passage text, a page title, or a page URL to log;
 * callers only pass short technical strings ('no_install_token',
 * 'status_500', an exception's .message). Local-only, capped, never
 * transmitted — the same local-persistence-is-not-level-C reasoning as the
 * quiz record (the project notes, statefulness).
 */

const STORAGE_KEY = 'sra_diag_log';
const MAX_ENTRIES = 20;
const URL_PATTERN = /https?:\/\/\S+/gi;

function sanitize(message) {
  return String(message == null ? '' : message).replace(URL_PATTERN, '[url removed]').slice(0, 200);
}

export function createDiagLog(opts = {}) {
  const storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  const now = opts.now || (() => Date.now());
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;

  function storageGet(keys) {
    return new Promise((resolve) => storage.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => storage.set(obj, () => resolve()));
  }

  /* Never throws — a logging call must not itself become a new failure on
   * an already-failing path. */
  async function log(context, message) {
    if (!storage) return;
    try {
      const existing = (await storageGet({ [STORAGE_KEY]: [] }))[STORAGE_KEY] || [];
      const entry = { at: now(), context: sanitize(context).slice(0, 40), message: sanitize(message) };
      await storageSet({ [STORAGE_KEY]: [entry, ...existing].slice(0, maxEntries) });
    } catch (e) { /* logging failure is not itself worth logging */ }
  }

  async function list() {
    if (!storage) return [];
    return (await storageGet({ [STORAGE_KEY]: [] }))[STORAGE_KEY] || [];
  }

  /* One click, from the diagnostics page. Same "deleting it works" promise
   * the project notes makes for the install token. */
  async function clear() {
    if (!storage) return;
    await storageSet({ [STORAGE_KEY]: [] });
  }

  return { log, list, clear };
}
