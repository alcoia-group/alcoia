/* session.js — the paid-tier magic-link session (item S3). See that file's
 * own header for why exchangeCode() here is the canonical, tested
 * definition of the exchange logic while background.js's onMessageExternal
 * listener (tests/background-session.test.js) carries an unavoidable, by-
 * hand mirror of it — a service worker cannot import this file.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSessionManager, STORAGE_KEY } from '../alcoia/src/shared/session.js';

function fakeStorage(seed = {}) {
  let store = { ...seed };
  return {
    get(keys, cb) {
      const result = {};
      for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
      cb(result);
    },
    set(obj, cb) { store = { ...store, ...obj }; if (cb) cb(); },
    remove(key, cb) { delete store[key]; if (cb) cb(); },
    _dump: () => store,
  };
}

const EXCHANGE_URL = 'https://api.alcoia.invalid/api/auth/extension-session/exchange';
const MAGIC_LINK_URL = 'https://api.alcoia.invalid/api/auth/magic-link';

describe('requestMagicLink', () => {
  it('POSTs the trimmed email and an extension-kind marker, returns true on success', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const m = createSessionManager({ storage: fakeStorage(), fetchImpl });

    const ok = await m.requestMagicLink('  reader@example.com  ', MAGIC_LINK_URL);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(MAGIC_LINK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'reader@example.com', kind: 'extension' }),
    });
  });

  it('never touches storage — nothing to store until the handoff completes', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const m = createSessionManager({ storage, fetchImpl });
    await m.requestMagicLink('reader@example.com', MAGIC_LINK_URL);
    expect(storage._dump()).toEqual({});
  });

  it('returns false for an empty or whitespace-only email, without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createSessionManager({ storage: fakeStorage(), fetchImpl });
    expect(await m.requestMagicLink('', MAGIC_LINK_URL)).toBe(false);
    expect(await m.requestMagicLink('   ', MAGIC_LINK_URL)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns false on a non-ok status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }));
    const m = createSessionManager({ storage: fakeStorage(), fetchImpl });
    expect(await m.requestMagicLink('reader@example.com', MAGIC_LINK_URL)).toBe(false);
  });

  it('returns false, never throws, on a network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createSessionManager({ storage: fakeStorage(), fetchImpl });
    await expect(m.requestMagicLink('reader@example.com', MAGIC_LINK_URL)).resolves.toBe(false);
  });
});

describe('exchangeCode — the full receive-code -> exchange -> session-stored path, mocked at the network boundary', () => {
  it('a valid code exchanges for a session and stores it, email included', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      // The CONFIRMED real shape (alcoiaServer's src/http/routes/
      // extension-session.js, createExtensionSessionRouter's success
      // response, after the item-S3 follow-up that added the account
      // lookup): { sessionToken, email, kind: 'extension', expiresAt:
      // <ISO> }. `email` was confirmed ABSENT in an earlier pass — that
      // route now looks the account up server-side and includes it.
      json: async () => ({ sessionToken: 'sess-abc', email: 'reader@example.com', kind: 'extension', expiresAt: '2099-01-01T00:00:00Z' }),
    }));
    const m = createSessionManager({ storage, fetchImpl });

    const result = await m.exchangeCode('one-time-code', EXCHANGE_URL);
    expect(result).toEqual({ ok: true, email: 'reader@example.com' });
    expect(fetchImpl).toHaveBeenCalledWith(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'one-time-code' }),
    });
    // Stored shape keeps THIS file's own field names (token/email/
    // expiresAt) — only the source property read off the response for the
    // token is `sessionToken`.
    expect(storage._dump()[STORAGE_KEY]).toEqual({
      token: 'sess-abc', email: 'reader@example.com', expiresAt: Date.parse('2099-01-01T00:00:00Z'),
    });
  });

  it('an empty code is rejected before any network call', async () => {
    const fetchImpl = vi.fn();
    const m = createSessionManager({ storage: fakeStorage(), fetchImpl });
    expect(await m.exchangeCode('', EXCHANGE_URL)).toEqual({ ok: false, error: 'no_code' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a response with the wrong token field name (old "token" instead of "sessionToken") is rejected as malformed', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'sess-abc', email: 'reader@example.com' }),
    }));
    const m = createSessionManager({ storage, fetchImpl });

    expect(await m.exchangeCode('c', EXCHANGE_URL)).toEqual({ ok: false, error: 'malformed_response' });
    expect(storage._dump()).toEqual({});
  });

  it('a response missing email is rejected as malformed, not stored with a blank/undefined email — regression guard for the item-S3 follow-up', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionToken: 'sess-abc', kind: 'extension', expiresAt: '2099-01-01T00:00:00Z' }),
    }));
    const m = createSessionManager({ storage, fetchImpl });

    expect(await m.exchangeCode('c', EXCHANGE_URL)).toEqual({ ok: false, error: 'malformed_response' });
    expect(storage._dump()).toEqual({});
  });
});

describe('exchangeCode — an expired or already-used code fails cleanly, never silently retried', () => {
  it('a non-ok response (expired/used/unknown) resolves to a clear rejection, and stores nothing', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 410 }));
    const m = createSessionManager({ storage, fetchImpl });

    const result = await m.exchangeCode('stale-code', EXCHANGE_URL);
    expect(result).toEqual({ ok: false, error: 'code_rejected', status: 410 });
    expect(storage._dump()).toEqual({});
    // Called exactly once — no retry loop.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an already-used code (a second exchange attempt) is rejected the same honest way', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ sessionToken: 't', email: 'a@b.com', kind: 'extension', expiresAt: '2099-01-01T00:00:00Z' }) }))
      .mockImplementationOnce(async () => ({ ok: false, status: 409 }));
    const m = createSessionManager({ storage, fetchImpl });

    const first = await m.exchangeCode('c', EXCHANGE_URL);
    expect(first.ok).toBe(true);
    const second = await m.exchangeCode('c', EXCHANGE_URL);
    expect(second).toEqual({ ok: false, error: 'code_rejected', status: 409 });
  });

  it('a malformed success response (missing sessionToken) is rejected, not trusted', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ oops: true }) }));
    const m = createSessionManager({ storage, fetchImpl });

    expect(await m.exchangeCode('c', EXCHANGE_URL)).toEqual({ ok: false, error: 'malformed_response' });
    expect(storage._dump()).toEqual({});
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    const m = createSessionManager({ storage: fakeStorage(), fetchImpl });
    await expect(m.exchangeCode('c', EXCHANGE_URL)).resolves.toEqual({ ok: false, error: 'network_error' });
  });

  it('a response body that is not JSON at all is rejected, not thrown', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
    const m = createSessionManager({ storage: fakeStorage(), fetchImpl });
    await expect(m.exchangeCode('c', EXCHANGE_URL)).resolves.toEqual({ ok: false, error: 'malformed_response' });
  });

  it('a missing expiresAt field still stores the session, with a generous fallback expiry rather than an immediate one', async () => {
    const storage = fakeStorage();
    const now = () => 1_000_000;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ sessionToken: 't', email: 'a@b.com', kind: 'extension' }) }));
    const m = createSessionManager({ storage, fetchImpl, now });

    await m.exchangeCode('c', EXCHANGE_URL);
    const stored = storage._dump()[STORAGE_KEY];
    expect(stored.expiresAt).toBeGreaterThan(now());
    // Generously in the future (the 90-day fallback), not a few minutes —
    // see session.js's own normaliseExpiry() comment for why.
    expect(stored.expiresAt - now()).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
  });
});

describe('getSession — "is there a valid session right now", not "does a key exist"', () => {
  it('returns null when nothing is stored', async () => {
    const m = createSessionManager({ storage: fakeStorage() });
    expect(await m.getSession()).toBeNull();
  });

  it('returns the stored session when it has not expired', async () => {
    const now = () => 1_000_000;
    const storage = fakeStorage({ [STORAGE_KEY]: { token: 't', email: 'a@b.com', expiresAt: 2_000_000 } });
    const m = createSessionManager({ storage, now });
    expect(await m.getSession()).toEqual({ token: 't', email: 'a@b.com', expiresAt: 2_000_000 });
  });

  it('returns null AND clears storage for an expired session — never reads as signed-in', async () => {
    const now = () => 3_000_000;
    const storage = fakeStorage({ [STORAGE_KEY]: { token: 't', email: 'a@b.com', expiresAt: 2_000_000 } });
    const m = createSessionManager({ storage, now });

    expect(await m.getSession()).toBeNull();
    expect(storage._dump()[STORAGE_KEY]).toBeUndefined();
  });

  it('returns null for a stored value missing a usable token, without throwing', async () => {
    const storage = fakeStorage({ [STORAGE_KEY]: { email: 'a@b.com' } });
    const m = createSessionManager({ storage });
    expect(await m.getSession()).toBeNull();
  });
});

describe('clearSession — sign-out', () => {
  it('clears the stored session unconditionally', async () => {
    const storage = fakeStorage({ [STORAGE_KEY]: { token: 't', email: 'a@b.com', expiresAt: 9_999_999_999_999 } });
    const m = createSessionManager({ storage });

    await m.clearSession();
    expect(storage._dump()[STORAGE_KEY]).toBeUndefined();
    expect(await m.getSession()).toBeNull();
  });

  it('is a no-op, not a throw, when nothing was stored', async () => {
    const m = createSessionManager({ storage: fakeStorage() });
    await expect(m.clearSession()).resolves.toBeUndefined();
  });
});
