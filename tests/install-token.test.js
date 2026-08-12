/* install-token.js — the opaque per-install token that gates every AI call.
 * See the project notes' Access control section for the design constraints this
 * pins: issued not derived, no token means no response, and a rejected
 * token self-heals by fetching a fresh one rather than needing the reader
 * to do anything.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInstallTokenManager } from '../alcoia/src/shared/install-token.js';

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

const TOKEN_URL = 'https://api.alcoia.invalid/api/token';

describe('issuing a token', () => {
  it('requests one when storage is empty, and stores what the server returns', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ token: 'abc123' }) }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });

    const token = await m.getToken();
    expect(token).toBe('abc123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(TOKEN_URL, { method: 'POST' });
    expect(storage._dump().sra_install_token).toBe('abc123');
  });

  it('is never derived from anything but the server response — the request carries no device or network fingerprint', async () => {
    // The whole point of "issued, not derived": the only optional argument
    // getToken() accepts is which URL to ask (so a developer overriding the
    // backend origin gets their token from the same place — see below), and
    // the request itself carries nothing computed about the device or the
    // network it is asking from.
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ token: 'xyz' }) }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });
    await m.getToken();
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe(TOKEN_URL);
    expect(calledInit).not.toHaveProperty('body');
    expect(Object.keys(calledInit)).toEqual(['method']);
  });

  it('a caller can override which URL to ask, for pointing a dev build at a local backend', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ token: 'local-token' }) }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });

    const localUrl = 'http://localhost:8731/api/token';
    const token = await m.getToken(localUrl);
    expect(token).toBe('local-token');
    expect(fetchImpl).toHaveBeenCalledWith(localUrl, { method: 'POST' });
  });

  it('reuses the stored token on a later call — one request per install, not one per page', async () => {
    const storage = fakeStorage({ sra_install_token: 'already-have-one' });
    const fetchImpl = vi.fn();
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });

    const token = await m.getToken();
    expect(token).toBe('already-have-one');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requests exactly once across several overlapping callers, the same way several tabs waking at once would', async () => {
    const storage = fakeStorage();
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });

    // Three "tabs" ask for a token before the first request has resolved.
    const p1 = m.getToken();
    const p2 = m.getToken();
    const p3 = m.getToken();

    // Let the shared in-flight promise's storage read resolve before the
    // mock fetch is actually invoked and resolveFetch gets assigned.
    await vi.waitFor(() => { if (!resolveFetch) throw new Error('not yet'); });
    resolveFetch({ ok: true, json: async () => ({ token: 'shared-token' }) });
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect([t1, t2, t3]).toEqual(['shared-token', 'shared-token', 'shared-token']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('every failure mode resolves to null, never a thrown error', () => {
  it('endpoint unreachable', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });
    await expect(m.getToken()).resolves.toBeNull();
    expect(storage._dump().sra_install_token).toBeFalsy();
  });

  it('non-ok status from the token endpoint', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });
    await expect(m.getToken()).resolves.toBeNull();
    expect(storage._dump().sra_install_token).toBeFalsy();
  });

  it('malformed response body — ok but no usable token field', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ oops: 'not a token' }) }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });
    await expect(m.getToken()).resolves.toBeNull();
    expect(storage._dump().sra_install_token).toBeFalsy();
  });

  it('response body is not JSON at all', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });
    await expect(m.getToken()).resolves.toBeNull();
  });

  it('a failed attempt does not poison the next one — a later retry can still succeed', async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('network down'); })
      .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ token: 'recovered' }) }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });

    await expect(m.getToken()).resolves.toBeNull();
    await expect(m.getToken()).resolves.toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('rejection self-heals', () => {
  it('invalidate() clears the stored token so the next getToken() fetches a fresh one', async () => {
    const storage = fakeStorage({ sra_install_token: 'stale-or-revoked' });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ token: 'fresh' }) }));
    const m = createInstallTokenManager({ storage, fetchImpl, tokenUrl: TOKEN_URL });

    await m.invalidate();
    expect(storage._dump().sra_install_token).toBeFalsy();

    const token = await m.getToken();
    expect(token).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
