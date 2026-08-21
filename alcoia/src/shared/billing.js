/* billing.js — checkout and the manage/cancel portal (item E3)
 *
 * Same shape as install-token.js/session.js/entitlements.js: small,
 * injectable storage-free dependencies (`fetchImpl`, `getSession`), never
 * throws, every failure resolves to an explicit `{ ok: false, error }`
 * rather than a guess.
 *
 * Every field name below is copied from reading alcoiaServer's
 * src/http/routes/billing.js directly, not inferred from this item's own
 * brief — see that read's own report for the full confirmation. In
 * particular: the request body is `{ plan }`, one of exactly 'reader' or
 * 'student' — never a product_id or a price, which the server's own
 * comment there is explicit a client must never be allowed to assert.
 * There is no billing-period field; this file does not invent one.
 *
 * This module never opens a tab itself — startCheckoutSession() and
 * getManagePortalUrl() only ever hand back the URL Creem/the server gave.
 * Both external hosted pages MUST open in a real tab (chrome.tabs.create),
 * never inside the popup or an iframe — Creem's checkout does not expect
 * to be framed, and a popup cannot host an external navigation anyway.
 * That decision is made once, by the caller (upgrade.js/account.js), not
 * duplicated here.
 */

export function createBillingManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const checkoutUrl = opts.checkoutUrl;
  const portalUrl = opts.portalUrl;

  function authHeaders(token) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  /* Returns { ok: true, checkoutUrl } or { ok: false, error }. `error` is
   * the server's own error code when one came back (invalid_plan,
   * billing_not_configured, invalid_session, account_not_found), or a
   * client-side one (no_session, malformed_response, network_error) —
   * never parsed from prose, never guessed when the server said nothing. */
  async function startCheckoutSession(plan) {
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!checkoutUrl || !fetchImpl) return { ok: false, error: 'no_checkout_url' };

    try {
      const resp = await fetchImpl(checkoutUrl, {
        method: 'POST',
        headers: authHeaders(session.token),
        body: JSON.stringify({ plan }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}` };
      }
      if (!data || typeof data.checkout_url !== 'string' || !data.checkout_url) {
        return { ok: false, error: 'malformed_response' };
      }
      return { ok: true, checkoutUrl: data.checkout_url };
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
  }

  /* Returns { ok: true, portalUrl } or { ok: false, error }. 'no_subscription'
   * is the server's own answer for an account that never had a Creem
   * customer id — a real, expected outcome for a free reader, not a bug. */
  async function getManagePortalUrl() {
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!portalUrl || !fetchImpl) return { ok: false, error: 'no_portal_url' };

    try {
      const resp = await fetchImpl(portalUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}` };
      }
      if (!data || typeof data.portal_url !== 'string' || !data.portal_url) {
        return { ok: false, error: 'malformed_response' };
      }
      return { ok: true, portalUrl: data.portal_url };
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
  }

  return { startCheckoutSession, getManagePortalUrl };
}
