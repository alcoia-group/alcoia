/* entitlements.js — the one place the extension asks "what can this reader
 * do" (item E1)
 *
 * Same shape as install-token.js: a small, dependency-light module with
 * injectable storage/fetchImpl/now for testing, never throws, every
 * failure degrades to the same safe default. Read that file's header first
 * if this one's reasoning looks familiar — it is, deliberately.
 *
 * "Everything goes through hasFeature()." No other file in this extension
 * may read chrome.storage for plan/tier state directly, or branch on a
 * tier string (`if (tier === 'reader')`) — SERVER-ARCHITECTURE.md §4 is
 * explicit that GET /api/entitlements returns `features[]`, not a bare
 * tier, precisely so a capability can be added server-side with no
 * extension release. Consumers ask "may I do X" (`hasFeature('own_documents')`);
 * they do not learn or care what tier grants it.
 *
 * FAIL CLOSED, always: no session, a network failure, a non-ok status, or
 * a response that doesn't parse into `{ tier: string, features: string[] }`
 * all resolve to the same free-tier value. A failure here must never
 * silently grant a paid feature — the inverse mistake (a paid reader
 * briefly reads as free after a hiccup) costs nothing but re-checking;
 * the mistake this guards against costs the product its billing model.
 *
 * CACHE: keyed on the CURRENT session's token, not just a bare TTL. A
 * cached entry fetched for a since-replaced or since-cleared session is
 * never reused, regardless of how fresh it is — checked before the TTL
 * even matters. This is what "signed-out resolves to free" means in
 * practice: it is not a special case, it falls out of the same check that
 * makes reader-A's cache never leak into reader-B's session on a shared
 * profile.
 *
 * TTL: 15 minutes. Chosen because this cache's own staleness is a UX
 * nicety, not the real gate — the server is (CLAUDE.md, "the client never
 * decides entitlement"), and a genuinely enforced action (e.g. a server
 * route requiring the paid tier) checks the CURRENT credential server-side
 * regardless of what this cache believes. Fifteen minutes is short enough
 * that a cancelled subscription cannot keep unlocking a feature for "days"
 * (the one hard requirement this item states explicitly), and long enough
 * that opening the popup repeatedly, or a page calling hasFeature() on
 * every render, does not turn into a network call every time. refresh()
 * exists precisely for the cases that cannot wait fifteen minutes: sign-in
 * (wired below, in account.js's own storage-change handler) and a manual
 * "refresh" action (the upgrade page, Phase 4 — not built here, only
 * exposed here for it to call).
 *
 * "On extension startup" is deliberately NOT a separate eager call site.
 * The TTL+session check above already means the first hasFeature() call
 * after ANY restart — cold service worker, reopened popup, freshly loaded
 * page — finds either no cache, a stale cache, or a cache for a session
 * that is no longer current, and fetches fresh automatically. Adding an
 * eager refresh on top would only spend a network call on installs that
 * never end up checking a paid feature that session at all.
 *
 * hasActiveSeat (item S6 follow-up): the server now echoes back, as its
 * own field, whether the account also holds an active class seat right
 * now — independent of whether that seat is what actually granted `tier`.
 * Confirmed by reading alcoiaServer's src/entitlements/resolve.js directly
 * before adding this: previously the field did not exist on the wire at
 * all, and a subscriber-with-a-seat was byte-for-byte indistinguishable
 * from a subscriber-without-one, because the resolution order (subscription
 * wins) discarded the seat fact once a subscription made it irrelevant to
 * `tier`. This is DISPLAY-ONLY — it never gates a feature and hasFeature()
 * does not consult it. A malformed/missing value degrades to `false`,
 * matching this field's own worst case: a reader who does hold a seat
 * would see a subscriber-only upgrade page (mildly wrong copy, no
 * capability lost or gained), never the reverse.
 */
import { createSessionManager } from './session.js';

export const STORAGE_KEY = 'sra_entitlements';
export const CACHE_TTL_MS = 15 * 60 * 1000;

const FREE = Object.freeze({ tier: 'free', features: Object.freeze([]), expires: null, hasActiveSeat: false });

export function createEntitlementsManager(opts = {}) {
  const storage   = opts.storage   || (typeof chrome !== 'undefined' ? chrome.storage.local : null);
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const now       = opts.now || (() => Date.now());
  const entitlementsUrl = opts.entitlementsUrl;
  // Reuses whatever session manager the caller already has (account.js's
  // own `session` instance, in practice) rather than constructing a second
  // one — only falls back to building a real one so this module is still
  // usable stand-alone. See session.js's own header for why THAT file is a
  // real ES module too, and cannot be reached from background.js the same
  // way.
  const getSession = opts.getSession
    || createSessionManager({ storage, fetchImpl, now }).getSession;

  function storageGet(keys) {
    return new Promise((resolve) => storage.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => storage.set(obj, () => resolve()));
  }

  /* The actual network call. Never throws, never returns anything outside
   * the `{ tier, features, expires }` shape — a malformed or missing
   * field anywhere collapses the whole response to FREE rather than
   * partially trusting it. */
  async function fetchFresh(token) {
    if (!entitlementsUrl || !fetchImpl) return { ...FREE };
    try {
      const resp = await fetchImpl(entitlementsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return { ...FREE };
      const data = await resp.json().catch(() => null);
      if (!data || typeof data.tier !== 'string' || !Array.isArray(data.features)
        || !data.features.every((f) => typeof f === 'string')) {
        return { ...FREE };
      }
      return {
        tier: data.tier,
        features: data.features,
        expires: typeof data.expires === 'string' ? data.expires : null,
        hasActiveSeat: data.hasActiveSeat === true,
        // Only the one state a student is ever told about: their seat's class
        // plan has expired. A grace period is the instructor's business and
        // the server does not send it to students, so anything else is ignored.
        ...(data.billing && data.billing.state === 'expired' ? { billing: { state: 'expired' } } : {}),
      };
    } catch (e) {
      return { ...FREE };
    }
  }

  // Several near-simultaneous hasFeature() calls (e.g. a page checking
  // three different features on load) share one request rather than
  // firing three — same reasoning, and same synchronous-before-the-first-
  // await assignment, as install-token.js's own inFlight dedup.
  let inFlight = null;

  /* Returns { tier, features[], expires } for the CURRENT session. Never
   * throws. Fail-closed to FREE for: no session, a cache belonging to a
   * different (or no) session token, a cache past CACHE_TTL_MS, or any
   * fetch failure. */
  function getEntitlements() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const session = await getSession();
        if (!session || typeof session.token !== 'string' || !session.token) {
          return { ...FREE };
        }

        const cached = (await storageGet({ [STORAGE_KEY]: null }))[STORAGE_KEY];
        const cacheIsCurrent = cached
          && cached.forToken === session.token
          && typeof cached.fetchedAt === 'number'
          && now() - cached.fetchedAt < CACHE_TTL_MS
          && cached.entitlements;
        if (cacheIsCurrent) return cached.entitlements;

        const entitlements = await fetchFresh(session.token);
        await storageSet({ [STORAGE_KEY]: { entitlements, forToken: session.token, fetchedAt: now() } });
        return entitlements;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  /* "May I do X" — the one interface every other module should use. Never
   * "does something exist in storage" (CLAUDE.md's own phrasing for this
   * exact anti-pattern, applied earlier to sessions — the same rule
   * applies to entitlements). */
  async function hasFeature(name) {
    const { features } = await getEntitlements();
    return features.includes(name);
  }

  /* The one narrow, deliberate exception to "never branch on tier" (see
   * this module's own header): the upgrade page needs to tell a
   * subscription apart from a class seat, because the action available
   * differs (manage billing vs. manage class membership), not because a
   * capability differs — features[] is identical either way. Derived from
   * two facts already on the response: `expires` is only ever set (by the
   * server's own resolution order) when the subscription branch is what
   * granted `tier`, so `expires !== null` means "subscription active" with
   * no further guessing needed; hasActiveSeat is the independent, honest
   * bit for "is a seat ALSO active right now," regardless of which one
   * decided `tier`. When both are true, source is 'subscription' (it is
   * what persists after any class is left — ALCOIA-PLATFORM-SPEC.md §6)
   * and hasActiveSeat stays true alongside it, rather than being hidden. */
  async function getEntitlementSource() {
    const { tier, expires, hasActiveSeat } = await getEntitlements();
    if (tier !== 'reader') return { source: 'free', hasActiveSeat: false };
    return { source: expires !== null ? 'subscription' : 'seat', hasActiveSeat: hasActiveSeat === true };
  }

  /* Bypasses the cache/TTL entirely and fetches fresh — for the two
   * triggers that cannot wait: a sign-in just completed, or the reader
   * explicitly asked (the upgrade page's manual refresh, Phase 4). A
   * signed-out reader refreshing clears any leftover cached entry rather
   * than leaving a stale one keyed to a token that no longer exists. */
  async function refresh() {
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      await storageSet({ [STORAGE_KEY]: null });
      return { ...FREE };
    }
    const entitlements = await fetchFresh(session.token);
    await storageSet({ [STORAGE_KEY]: { entitlements, forToken: session.token, fetchedAt: now() } });
    return entitlements;
  }

  /* DISPLAY-ONLY, like hasActiveSeat: "your class plan expired" is shown so a
   * reader knows why Reader went away. It never gates anything. Returns
   * { state: 'expired' } or null. */
  async function getBillingNotice() {
    const { billing } = await getEntitlements();
    return billing && billing.state === 'expired' ? { state: 'expired' } : null;
  }

  return { hasFeature, getEntitlements, getEntitlementSource, getBillingNotice, refresh };
}
