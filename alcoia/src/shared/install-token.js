/* install-token.js — the opaque per-install token that gates every AI call
 *
 * "No account is required to use the extension. AI calls are gated by an
 * install token." (the project notes, Access control.) On first run the extension
 * requests an opaque token from the server and stores it; every AI call
 * carries it; no token, no response. The server counts against the token
 * and enforces the ceiling — the client never decides, it only relays.
 *
 * The token is ISSUED, not derived. This file only ever stores what the
 * server hands back for a fetch it made itself — never anything computed
 * from device or network characteristics. If a future change makes this
 * file compute the token from anything other than the server's response
 * body, that is a fingerprinting regression and invariant 1 is being
 * violated; see the project notes' Access control section before doing that.
 *
 * Lives in src/shared/ as a real ES module, loaded by content.js's
 * loadModule() (a dynamic import(), same as every other content module) —
 * deliberately NOT loaded from background.js despite that being where the
 * actual AI-call fetch happens. Chrome disallows dynamic import() from
 * inside a service worker outright ("import() is disallowed on
 * ServiceWorkerGlobalScope by the HTML specification"), so this file is
 * loaded where dynamic import() actually works, and content.js passes the
 * resolved token to background.js as a plain string in the message body —
 * see content.js's fetchSummary/fetchQuestions and background.js's
 * 'summarize'/'apiPost' handler. That keeps this file unit-testable in
 * isolation, which a copy pasted into every load site would not be.
 */

const STORAGE_KEY = 'sra_install_token';

export function createInstallTokenManager(opts = {}) {
  const storage      = opts.storage   || (typeof chrome !== 'undefined' ? chrome.storage.local : null);
  const fetchImpl    = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const defaultUrl   = opts.tokenUrl;

  function storageGet(keys) {
    return new Promise((resolve) => storage.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => storage.set(obj, () => resolve()));
  }

  // Shared by every caller in the same overlapping window, so several tabs
  // waking at once still produce one request — not one each.
  let inFlight = null;

  /* Returns the token, or null if none can be produced right now. Every
   * failure mode collapses to null here: unreachable endpoint, a non-ok
   * status, or a response that doesn't parse into { token: string }. None
   * of them throws past this function — the caller (background.js) reads
   * null as "no token, no response" and the AI call simply doesn't happen.
   *
   * The whole body — including the storage read, not just the fetch — runs
   * inside `inFlight`, and `inFlight` is assigned synchronously before the
   * first `await`. That matters: several callers arriving in the same tick
   * (several tabs waking near-simultaneously) all check `inFlight` before
   * any of them has had a chance to await anything, so the check has to be
   * synchronous too, or all of them would see it unset and each start their
   * own fetch. This is the difference between "one request per install" and
   * "one request per tab".
   *
   * `urlOverride` lets the caller derive the token endpoint from wherever
   * the actual AI call is going — a developer pointing the popup's Backend
   * URL setting at a local server should get their token from that same
   * server, not from the shipped default. Falls back to the constructor's
   * `tokenUrl` when omitted. */
  function getToken(urlOverride) {
    if (inFlight) return inFlight;
    const tokenUrl = urlOverride || defaultUrl;

    inFlight = (async () => {
      try {
        const stored = (await storageGet({ [STORAGE_KEY]: null }))[STORAGE_KEY];
        if (stored) return stored;
        if (!tokenUrl || !fetchImpl) return null;

        const resp = await fetchImpl(tokenUrl, { method: 'POST' });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data || typeof data.token !== 'string' || !data.token) return null;
        await storageSet({ [STORAGE_KEY]: data.token });
        return data.token;
      } catch (e) {
        return null;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  /* Call when the server rejects the token on a real AI call (401/403) — a
   * revoked or expired token, not a network failure. Clearing the stored
   * value means the next getToken() issues a fresh one automatically. This
   * is also what "the reader can delete it, and deleting it works" (the project notes)
   * relies on: clearing sra_install_token by any means, including a future
   * diagnostics-page control, has exactly this effect. */
  async function invalidate() {
    await storageSet({ [STORAGE_KEY]: null });
  }

  return { getToken, invalidate };
}
