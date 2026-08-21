/* session.js — the paid-tier magic-link session (item S3)
 *
 * Mirrors install-token.js's shape and reasoning closely — read that file's
 * own header first. Same "issued, not derived, opaque, hashed server-side"
 * credential model (SERVER-ARCHITECTURE.md §4), same injectable
 * storage/fetchImpl for testing without a real chrome/fetch global. What's
 * different, and why this file is NOT loaded the way install-token.js is:
 *
 * - install-token.js is loaded via loadModule() — a dynamic import() —
 *   which content SCRIPTS can do and service workers cannot ("import() is
 *   disallowed on ServiceWorkerGlobalScope by the HTML specification").
 *   That's exactly why install-token.js lives where dynamic import() works
 *   and hands background.js a resolved string instead of being loaded
 *   there directly.
 * - Here the same constraint bites harder. The one-time CODE this module's
 *   exchangeCode() consumes can ONLY ever be received by background.js's
 *   own chrome.runtime.onMessageExternal listener — content scripts and
 *   extension pages cannot receive that event at all, a Chrome platform
 *   fact, not a design choice (see manifests/base.json's
 *   externally_connectable and background.js's own listener). So the one
 *   place the exchange call structurally has to run is the one place that
 *   cannot import this file, dynamically OR statically — background.js's
 *   service worker carries no `"type": "module"` (manifests/chrome.json),
 *   by design, so it can keep loading via plain importScripts() the same
 *   way Firefox's background.scripts array works (see build.mjs's own
 *   header on why the two targets do not share more than they do).
 *
 * exchangeCode() below is still exported and still fully unit-tested
 * (tests/session.test.js) — it is the CANONICAL, verified definition of
 * what a correct exchange does: validate the response shape, never trust a
 * token/email pair that doesn't come back looking exactly right, store the
 * result, never silently retry a rejected code. background.js's own
 * onMessageExternal listener mirrors this exact shape by hand, out of
 * necessity, not carelessness — see that file's own comment at the point it
 * does, and tests/background-session.test.js, which exercises that copy
 * directly rather than assuming the mirroring held. If this function's
 * behaviour ever changes, that listener needs the same change made by
 * hand; there is no import to make it automatic, which is the one real
 * cost of the platform constraint above.
 *
 * requestMagicLink() has no such constraint — it runs from wherever the
 * sign-in screen lives (src/popup/account.js, a real ES module extension
 * page), which can call this directly, the same way any other extension
 * page reaches the backend.
 *
 * getSession()'s job is "is there a valid session RIGHT NOW", never "does
 * a key exist in storage" — a stale or locally-expired entry reads as
 * signed-out and is cleared as a side effect of being read. This is a
 * self-heal, not the real gate: the server is what actually enforces
 * expiry on the next authenticated call (the project notes: "the client never
 * decides entitlement"). Every paid-feature check in this codebase must
 * call getSession() (or something that itself calls it), never read
 * sra_session out of storage directly and treat presence as truth.
 */

export const STORAGE_KEY = 'sra_session';

export function createSessionManager(opts = {}) {
  const storage   = opts.storage   || (typeof chrome !== 'undefined' ? chrome.storage.local : null);
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const now       = opts.now || (() => Date.now());

  function storageGet(keys) {
    return new Promise((resolve) => storage.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => storage.set(obj, () => resolve()));
  }
  function storageRemove(key) {
    return new Promise((resolve) => storage.remove(key, () => resolve()));
  }

  /* Requests a magic link for `email`. Returns true if the server accepted
   * the request (an email is presumably on its way), false on any failure
   * — network, non-ok status, a missing email, or no fetch/url available.
   * Never throws. This never touches storage — there is nothing to store
   * until the reader clicks the link and the landing-page handoff
   * (background.js) completes; this call's own true/false is the only
   * thing the sign-in screen has to decide "check your email" vs. an error
   * from. */
  async function requestMagicLink(email, urlOverride) {
    const url = urlOverride;
    const trimmed = String(email || '').trim();
    if (!trimmed || !url || !fetchImpl) return false;
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 'extension' pins which session KIND the eventual link mints
        // (SERVER-ARCHITECTURE.md §4: "three session kinds"). This field
        // name and value are ASSUMED — that section names the exchange
        // endpoint explicitly but not the magic-link request shape.
        // Confirm against the real alcoiaServer route before relying on
        // this in production; flagged again in this file's own PR report.
        body: JSON.stringify({ email: trimmed, kind: 'extension' }),
      });
      return resp.ok;
    } catch (e) {
      return false;
    }
  }

  /* Exchanges a one-time code (handed off from the landing page) for a real
   * session, and stores it. Returns { ok: true, email } on success,
   * { ok: false, error } on any failure — expired code, already-used code,
   * network failure, or a response that fails shape validation. Never
   * throws, never retries: a rejected code is reported honestly, once
   * (the project notes invariant 8's "every failure degrades to silence" pattern,
   * applied to sign-in — the difference here is a rejection surfaces as an
   * explicit `ok:false`, not silence, since a reader trying to sign in
   * needs to know it failed). */
  async function exchangeCode(code, urlOverride) {
    const url = urlOverride;
    const trimmed = String(code || '').trim();
    if (!trimmed) return { ok: false, error: 'no_code' };
    if (!url || !fetchImpl) return { ok: false, error: 'no_exchange_url' };

    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      if (!resp.ok) {
        // Expired, unknown, or already-consumed all collapse to the same
        // honest "rejected" outcome — SERVER-ARCHITECTURE.md does not pin
        // a distinct status code per failure mode, and guessing which one
        // from the status alone risks misreporting it.
        return { ok: false, error: 'code_rejected', status: resp.status };
      }
      const data = await resp.json().catch(() => null);
      // ASSUMED response shape — SERVER-ARCHITECTURE.md §4 names this
      // endpoint but not its success payload. Modelled on this server's
      // other credential responses (install-token.js's own
      // `{ token: string }`; GET /api/entitlements's `{ tier, features[],
      // expires }`): `{ token: string, email: string, expires?:
      // string|number }`. Confirm against the real route before relying on
      // this in production.
      if (!data || typeof data.token !== 'string' || !data.token
        || typeof data.email !== 'string' || !data.email) {
        return { ok: false, error: 'malformed_response' };
      }

      const session = { token: data.token, email: data.email, expiresAt: normaliseExpiry(data.expires, now) };
      await storageSet({ [STORAGE_KEY]: session });
      return { ok: true, email: session.email };
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
  }

  /* "Is there a valid session right now" — see this file's own header.
   * Returns the stored session, or null for anything short of a genuinely
   * present, unexpired one. An expired entry is cleared as a side effect
   * of being read here, not left to accumulate or silently keep reading as
   * signed-in. */
  async function getSession() {
    if (!storage) return null;
    const stored = (await storageGet({ [STORAGE_KEY]: null }))[STORAGE_KEY];
    if (!stored || typeof stored.token !== 'string' || !stored.token) return null;
    if (typeof stored.expiresAt === 'number' && stored.expiresAt <= now()) {
      await storageRemove(STORAGE_KEY);
      return null;
    }
    return stored;
  }

  /* Signs out. Clears the stored session unconditionally — the reader
   * asked to leave, not to be told whether they were signed in first. */
  async function clearSession() {
    if (!storage) return;
    await storageRemove(STORAGE_KEY);
  }

  return { requestMagicLink, exchangeCode, getSession, clearSession };
}

/* No usable expiry in the response — defaults GENEROUSLY (90 days,
 * matching SERVER-ARCHITECTURE.md §4's description of the extension
 * credential as "longer-lived") rather than short. getSession()'s local
 * expiry check is a UX self-heal, not the real gate — the server is what
 * actually rejects an expired token on the next authenticated call. A
 * wrong guess here costs a stale-looking "signed in" for a while, not a
 * security hole; guessing short would instead make a successful sign-in
 * look like it silently failed a few minutes later, which is worse. */
function normaliseExpiry(raw, now) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now() + 90 * 24 * 60 * 60 * 1000;
}
