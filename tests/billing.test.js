/* billing.js — checkout and the manage/cancel portal (item E3). Field
 * names asserted here (plan, checkout_url, portal_url, the error codes)
 * are copied from reading alcoiaServer's src/http/routes/billing.js
 * directly — see that item's own PR report for the confirmation.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBillingManager } from '../alcoia/src/shared/billing.js';

const CHECKOUT_URL = 'https://api.alcoia.invalid/api/billing/checkout';
const PORTAL_URL = 'https://api.alcoia.invalid/api/billing/portal';

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('startCheckoutSession', () => {
  it('POSTs { plan } as the exact body, Bearer-authenticated, and returns the confirmed checkout_url field', async () => {
    let seenUrl = null;
    let seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url; seenInit = init;
      return { ok: true, json: async () => ({ checkout_url: 'https://creem.test/session/abc' }) };
    });
    const m = createBillingManager({ fetchImpl, checkoutUrl: CHECKOUT_URL, getSession: sessionOf('tok-1') });

    const result = await m.startCheckoutSession('reader');
    expect(result).toEqual({ ok: true, checkoutUrl: 'https://creem.test/session/abc' });
    expect(seenUrl).toBe(CHECKOUT_URL);
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seenInit.body)).toEqual({ plan: 'reader' });
    // No product_id, no price, nothing beyond the plan key — the server's
    // own comment is explicit that a client asserting either is the
    // exact thing this must never do.
    expect(JSON.parse(seenInit.body)).not.toHaveProperty('product_id');
    expect(JSON.parse(seenInit.body)).not.toHaveProperty('price');
  });

  it('with no session, never calls fetch and returns no_session', async () => {
    const fetchImpl = vi.fn();
    const m = createBillingManager({ fetchImpl, checkoutUrl: CHECKOUT_URL, getSession: sessionOf(null) });

    expect(await m.startCheckoutSession('reader')).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces the server\'s own error code on a 422 invalid_plan', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: 'invalid_plan' }) }));
    const m = createBillingManager({ fetchImpl, checkoutUrl: CHECKOUT_URL, getSession: sessionOf('tok-1') });
    expect(await m.startCheckoutSession('not-a-real-plan')).toEqual({ ok: false, error: 'invalid_plan' });
  });

  it('surfaces billing_not_configured on a 503', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'billing_not_configured' }) }));
    const m = createBillingManager({ fetchImpl, checkoutUrl: CHECKOUT_URL, getSession: sessionOf('tok-1') });
    expect(await m.startCheckoutSession('reader')).toEqual({ ok: false, error: 'billing_not_configured' });
  });

  it('surfaces invalid_session on a 401 (an expired/revoked session the client did not yet notice)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_session' }) }));
    const m = createBillingManager({ fetchImpl, checkoutUrl: CHECKOUT_URL, getSession: sessionOf('tok-1') });
    expect(await m.startCheckoutSession('reader')).toEqual({ ok: false, error: 'invalid_session' });
  });

  it('a malformed success response (missing checkout_url) is rejected, not trusted', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ oops: true }) }));
    const m = createBillingManager({ fetchImpl, checkoutUrl: CHECKOUT_URL, getSession: sessionOf('tok-1') });
    expect(await m.startCheckoutSession('reader')).toEqual({ ok: false, error: 'malformed_response' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createBillingManager({ fetchImpl, checkoutUrl: CHECKOUT_URL, getSession: sessionOf('tok-1') });
    await expect(m.startCheckoutSession('reader')).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});

describe('getManagePortalUrl', () => {
  it('GETs with Bearer auth and returns the confirmed portal_url field', async () => {
    let seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenInit = init;
      return { ok: true, json: async () => ({ portal_url: 'https://creem.test/portal/xyz' }) };
    });
    const m = createBillingManager({ fetchImpl, portalUrl: PORTAL_URL, getSession: sessionOf('tok-1') });

    expect(await m.getManagePortalUrl()).toEqual({ ok: true, portalUrl: 'https://creem.test/portal/xyz' });
    expect(seenInit).toEqual({ method: 'GET', headers: { Authorization: 'Bearer tok-1' } });
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createBillingManager({ fetchImpl, portalUrl: PORTAL_URL, getSession: sessionOf(null) });
    expect(await m.getManagePortalUrl()).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces no_subscription on a 404 — a free reader who never subscribed, not a bug', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'no_subscription' }) }));
    const m = createBillingManager({ fetchImpl, portalUrl: PORTAL_URL, getSession: sessionOf('tok-1') });
    expect(await m.getManagePortalUrl()).toEqual({ ok: false, error: 'no_subscription' });
  });

  it('a malformed success response (missing portal_url) is rejected, not trusted', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const m = createBillingManager({ fetchImpl, portalUrl: PORTAL_URL, getSession: sessionOf('tok-1') });
    expect(await m.getManagePortalUrl()).toEqual({ ok: false, error: 'malformed_response' });
  });
});
