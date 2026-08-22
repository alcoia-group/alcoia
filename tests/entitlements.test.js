/* entitlements.js — "what can this reader do" (item E1). See that file's
 * own header for the fail-closed and session-scoped-cache reasoning this
 * exercises.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEntitlementsManager, STORAGE_KEY, CACHE_TTL_MS } from '../alcoia/src/shared/entitlements.js';

function fakeStorage(seed = {}) {
  let store = { ...seed };
  return {
    get(keys, cb) {
      const result = {};
      for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
      cb(result);
    },
    set(obj, cb) { store = { ...store, ...obj }; if (cb) cb(); },
    _dump: () => store,
  };
}

const ENTITLEMENTS_URL = 'https://api.alcoia.invalid/api/entitlements';
const READER_FEATURES = ['own_documents', 'portable_receipt', 'sync'];

function sessionOf(token, extra = {}) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999, ...extra } : null);
}

describe('hasFeature returns correctly for each tier\'s feature set', () => {
  it('a reader-tier session with the real feature list grants each of its own features and nothing else', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: null }),
    }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    expect(await m.hasFeature('own_documents')).toBe(true);
    expect(await m.hasFeature('portable_receipt')).toBe(true);
    expect(await m.hasFeature('sync')).toBe(true);
    expect(await m.hasFeature('something_not_granted')).toBe(false);
  });

  it('a free-tier session (empty features[]) grants nothing', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'free', features: [], expires: null }),
    }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    for (const f of READER_FEATURES) expect(await m.hasFeature(f)).toBe(false);
  });

  it('getEntitlements exposes the real tier/expires too, not just the features list', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: '2099-01-01T00:00:00Z' }),
    }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    expect(await m.getEntitlements()).toEqual({
      tier: 'reader', features: READER_FEATURES, expires: '2099-01-01T00:00:00Z', hasActiveSeat: false,
    });
  });

  it('getEntitlements exposes hasActiveSeat (item S6 follow-up) as its own bit, independent of tier', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: null, hasActiveSeat: true }),
    }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    expect(await m.getEntitlements()).toEqual({
      tier: 'reader', features: READER_FEATURES, expires: null, hasActiveSeat: true,
    });
  });

  it('a missing or non-boolean hasActiveSeat from the server degrades to false, never trusted as true', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: null, hasActiveSeat: 'yes' }),
    }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    expect((await m.getEntitlements()).hasActiveSeat).toBe(false);
  });
});

describe('getEntitlementSource (item S6 follow-up)', () => {
  it('free tier: source free, hasActiveSeat false', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ tier: 'free', features: [], expires: null, hasActiveSeat: false }) }));
    const m = createEntitlementsManager({ storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getEntitlementSource()).toEqual({ source: 'free', hasActiveSeat: false });
  });

  it('subscription active, no seat: source subscription', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: '2099-01-01T00:00:00Z', hasActiveSeat: false }),
    }));
    const m = createEntitlementsManager({ storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getEntitlementSource()).toEqual({ source: 'subscription', hasActiveSeat: false });
  });

  it('seat active, no subscription: source seat', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: null, hasActiveSeat: true }),
    }));
    const m = createEntitlementsManager({ storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getEntitlementSource()).toEqual({ source: 'seat', hasActiveSeat: true });
  });

  it('both active: source is subscription (it is what persists after leaving the class), but hasActiveSeat is NOT hidden', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: '2099-01-01T00:00:00Z', hasActiveSeat: true }),
    }));
    const m = createEntitlementsManager({ storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getEntitlementSource()).toEqual({ source: 'subscription', hasActiveSeat: true });
  });

  it('signed out: source free, no fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createEntitlementsManager({ storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf(null) });
    expect(await m.getEntitlementSource()).toEqual({ source: 'free', hasActiveSeat: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('signed-out resolves to free, without ever calling fetch', () => {
  it('no session at all', async () => {
    const fetchImpl = vi.fn();
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf(null),
    });

    expect(await m.getEntitlements()).toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
    expect(await m.hasFeature('own_documents')).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a failed fetch resolves to free, not a stale cached reader state past its TTL', () => {
  it('an expired cached "reader" entry, combined with a now-failing fetch, does NOT fall back to the stale reader value', async () => {
    const now = () => 1_000_000;
    const storage = fakeStorage({
      [STORAGE_KEY]: {
        entitlements: { tier: 'reader', features: READER_FEATURES, expires: null },
        forToken: 'tok-1',
        fetchedAt: 1_000_000 - CACHE_TTL_MS - 1, // one millisecond past the TTL
      },
    });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
    const m = createEntitlementsManager({
      storage, fetchImpl, now, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    const result = await m.getEntitlements();
    expect(result).toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
    expect(await m.hasFeature('own_documents')).toBe(false);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('a network failure resolves to free, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });
    await expect(m.getEntitlements()).resolves.toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
  });

  it('a malformed response (missing features array) resolves to free, not partially trusted', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ tier: 'reader' }) }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });
    await expect(m.getEntitlements()).resolves.toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
  });

  it('a response body that is not JSON at all resolves to free, not thrown', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });
    await expect(m.getEntitlements()).resolves.toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
  });
});

describe('caching — within the TTL and scoped to the current session', () => {
  it('a fresh cache for the CURRENT session token is reused, without a second fetch', async () => {
    const now = () => 1_000_000;
    const storage = fakeStorage({
      [STORAGE_KEY]: {
        entitlements: { tier: 'reader', features: READER_FEATURES, expires: null },
        forToken: 'tok-1',
        fetchedAt: 1_000_000 - 1000, // well within CACHE_TTL_MS
      },
    });
    const fetchImpl = vi.fn();
    const m = createEntitlementsManager({
      storage, fetchImpl, now, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    expect(await m.getEntitlements()).toEqual({ tier: 'reader', features: READER_FEATURES, expires: null });
    expect(await m.hasFeature('sync')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a cache fetched for a DIFFERENT session token is never reused, even if well within the TTL', async () => {
    const now = () => 1_000_000;
    const storage = fakeStorage({
      [STORAGE_KEY]: {
        entitlements: { tier: 'reader', features: READER_FEATURES, expires: null },
        forToken: 'someone-elses-token',
        fetchedAt: 1_000_000 - 1000,
      },
    });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ tier: 'free', features: [], expires: null }) }));
    const m = createEntitlementsManager({
      storage, fetchImpl, now, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    const result = await m.getEntitlements();
    expect(result).toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('several near-simultaneous calls share one fetch (in-flight dedup)', async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    const p1 = m.getEntitlements();
    const p2 = m.hasFeature('own_documents');
    const p3 = m.getEntitlements();

    await vi.waitFor(() => { if (!resolveFetch) throw new Error('not yet'); });
    resolveFetch({ ok: true, json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: null }) });

    const [e1, has, e3] = await Promise.all([p1, p2, p3]);
    expect(e1).toEqual({ tier: 'reader', features: READER_FEATURES, expires: null, hasActiveSeat: false });
    expect(has).toBe(true);
    expect(e3).toEqual(e1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('refresh — reflected without a full extension reload', () => {
  it('a plan cancellation (reader -> free) is picked up on the very next check after refresh(), no re-construction needed', async () => {
    const now = () => 1_000_000;
    const storage = fakeStorage();
    let plan = { tier: 'reader', features: READER_FEATURES, expires: null };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => plan }));
    const m = createEntitlementsManager({
      storage, fetchImpl, now, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-1'),
    });

    expect(await m.hasFeature('sync')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Still well within the TTL — without refresh(), the cache alone would
    // still say 'reader'.
    expect(await m.hasFeature('sync')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The plan changed server-side; the reader (or the upgrade page,
    // Phase 4) triggers an explicit refresh.
    plan = { tier: 'free', features: [], expires: null };
    const refreshed = await m.refresh();
    expect(refreshed).toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });

    expect(await m.hasFeature('sync')).toBe(false);
    expect(storage._dump()[STORAGE_KEY].entitlements).toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
  });

  it('refresh() with no session clears any leftover cached entry rather than leaving a stale one', async () => {
    const storage = fakeStorage({
      [STORAGE_KEY]: { entitlements: { tier: 'reader', features: READER_FEATURES, expires: null }, forToken: 'tok-1', fetchedAt: Date.now() },
    });
    const fetchImpl = vi.fn();
    const m = createEntitlementsManager({
      storage, fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf(null),
    });

    const result = await m.refresh();
    expect(result).toEqual({ tier: 'free', features: [], expires: null, hasActiveSeat: false });
    expect(storage._dump()[STORAGE_KEY]).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refresh() sends the current session token as a Bearer credential', async () => {
    let seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenInit = init;
      return { ok: true, json: async () => ({ tier: 'reader', features: READER_FEATURES, expires: null }) };
    });
    const m = createEntitlementsManager({
      storage: fakeStorage(), fetchImpl, entitlementsUrl: ENTITLEMENTS_URL, getSession: sessionOf('tok-xyz'),
    });

    await m.refresh();
    expect(seenInit).toEqual({ method: 'GET', headers: { Authorization: 'Bearer tok-xyz' } });
  });
});
