/* proxy-fetch.js — a fetchImpl that routes through background.js instead of
 * calling fetch() directly from content-script (or extension-page) context.
 *
 * install-token.js's getToken() and outcomes.js/kinematics.js/
 * explanation-events.js's submit() each accept an injectable `fetchImpl`
 * (defaulting to the real global fetch) precisely so a caller can swap in
 * something else without touching those files' own request-building logic
 * at all — this is that something else, and none of the four had their own
 * code changed to use it.
 *
 * Why: a content script's own fetch to server.alcoia.app carries the
 * origin of the page it's running on (en.wikipedia.org, bbc.com, ...); the
 * server's CORS response is a fixed Access-Control-Allow-Origin:
 * https://alcoia.app that can never match a real reading page's origin, so
 * the browser rejects the response before any of those four callers ever
 * see it — confirmed against the real production server with a live QA
 * pass, not assumed. background.js's own fetch (dispatched from the
 * extension's privileged context, not a page's) carries no page origin at
 * all, so it isn't subject to that.
 *
 * Distinct from background.js's existing 'summarize'/'apiPost' handler,
 * which hardcodes the X-Alcoia-Install-Token header those two AI-call
 * paths need. The four callers here don't share one auth shape between
 * them — the token fetch itself carries none, and the three
 * assignment-reporting submits use `Authorization: Bearer <session
 * token>`, not the install-token header — so this passes whatever
 * `options` (method, headers, body) the caller already built straight
 * through to background.js unchanged, the same object fetch() itself
 * would take, rather than assuming one fixed auth shape.
 */
export function backgroundFetchImpl(url, options) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'proxyFetch', url, options }, (resp) => {
        // No response at all (no listener, extension context gone) —
        // collapses to the same "ok: false" shape a network-level fetch
        // failure would, so every caller's existing !resp.ok handling
        // covers this without a separate branch.
        if (chrome.runtime.lastError || !resp) {
          resolve({ ok: false, status: 0, json: async () => null });
          return;
        }
        resolve({ ok: !!resp.ok, status: resp.status || 0, json: async () => resp.data });
      });
    } catch (e) {
      resolve({ ok: false, status: 0, json: async () => null });
    }
  });
}
