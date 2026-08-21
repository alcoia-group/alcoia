// @vitest-environment jsdom
/* background.js's chrome.runtime.onMessageExternal listener (item S3) —
 * the receiving end of the magic-link sign-in handoff from the Phase 1
 * landing page (alcoiaWeb, a separate repo, not built here).
 *
 * background.js has no exports at all (a classic, non-module service
 * worker) — it is exercised the only way a plain script with top-level
 * side effects can be: stub the globals it expects, import it once for its
 * side effects, and capture the listener function it registered via the
 * stubbed chrome.runtime.onMessageExternal.addListener(). This mirrors
 * host.test.js's own "exercise the real module through a fake chrome
 * global" approach, adapted for a file with no factory function to call.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

let capturedListener = null;

function fakeChromeForImport() {
  return {
    tabs: { onUpdated: { addListener: () => {} }, create: () => {}, update: () => {} },
    webNavigation: { onHistoryStateUpdated: { addListener: () => {} } },
    storage: {
      local: {
        _store: {},
        get(keys, cb) {
          const result = {};
          for (const [k, def] of Object.entries(keys || {})) result[k] = k in this._store ? this._store[k] : def;
          cb(result);
        },
        set(obj, cb) { Object.assign(this._store, obj); if (cb) cb(); },
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      onMessageExternal: { addListener: (fn) => { capturedListener = fn; } },
      getURL: (p) => 'chrome-extension://test/' + p,
      lastError: undefined,
    },
  };
}

const WEB_APP_ORIGIN = 'http://localhost:5173';
const EXCHANGE_URL = 'https://api.alcoia.invalid/api/auth/extension-session/exchange';

beforeAll(async () => {
  vi.stubGlobal('chrome', fakeChromeForImport());
  vi.stubGlobal('ALCOIA_CONFIG', {
    WEB_APP_ORIGIN,
    EXTENSION_SESSION_EXCHANGE_URL: EXCHANGE_URL,
    SESSION_STORAGE_KEY: 'sra_session',
    SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
  });
  // background.js has no exports — imported once, for its top-level
  // chrome.runtime.onMessageExternal.addListener(...) call, which the fake
  // above captures into `capturedListener`.
  await import('../alcoia/background.js');
  expect(capturedListener).toBeTypeOf('function');
});

beforeEach(() => {
  chrome.storage.local._store = {};
});

function sender(origin) {
  return { origin };
}

describe('onMessageExternal rejects a message from an origin not in the allowed list', () => {
  it('rejects a mismatched origin without ever calling fetch', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const sendResponse = vi.fn();

    capturedListener({ code: 'some-code' }, sender('https://evil.example.com'), sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'origin_not_allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a message with no sender/origin at all', () => {
    const sendResponse = vi.fn();
    capturedListener({ code: 'some-code' }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'origin_not_allowed' });
  });

  it('rejects an empty or missing code from an otherwise-allowed origin, without calling fetch', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const sendResponse = vi.fn();

    capturedListener({}, sender(WEB_APP_ORIGIN), sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'no_code' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the full receive-code -> exchange -> session-stored path, mocked at the network boundary', () => {
  it('a valid code from the allowed origin exchanges and stores the session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(url).toBe(EXCHANGE_URL);
      expect(JSON.parse(init.body)).toEqual({ code: 'good-code' });
      // The CONFIRMED real shape (alcoiaServer's src/http/routes/
      // extension-session.js, createExtensionSessionRouter's success
      // response): { sessionToken, kind: 'extension', expiresAt: <ISO> }.
      // No `email` field exists in this response at all.
      return { ok: true, json: async () => ({ sessionToken: 'sess-1', kind: 'extension', expiresAt: '2099-01-01T00:00:00Z' }) };
    }));
    const sendResponse = vi.fn();

    const keepChannelOpen = capturedListener({ code: 'good-code' }, sender(WEB_APP_ORIGIN), sendResponse);
    expect(keepChannelOpen).toBe(true);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    // Stored shape keeps this listener's own field names (token/expiresAt)
    // — only the source property read off the response is `sessionToken`.
    expect(chrome.storage.local._store.sra_session).toEqual({
      token: 'sess-1', expiresAt: Date.parse('2099-01-01T00:00:00Z'),
    });
  });

  it('the OLD assumed shape ({ token, email }) is correctly rejected as malformed now — regression guard for this fix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'sess-1', email: 'reader@example.com' }),
    })));
    const sendResponse = vi.fn();

    capturedListener({ code: 'good-code' }, sender(WEB_APP_ORIGIN), sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'malformed_response' });
    expect(chrome.storage.local._store.sra_session).toBeUndefined();
  });
});

describe('an expired or already-used code fails cleanly and visibly', () => {
  it('a non-ok exchange response is reported honestly and stores nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 410 })));
    const sendResponse = vi.fn();

    capturedListener({ code: 'stale-code' }, sender(WEB_APP_ORIGIN), sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'code_rejected', status: 410 });
    expect(chrome.storage.local._store.sra_session).toBeUndefined();
  });

  it('a malformed success response is rejected, not trusted into storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ nope: true }) })));
    const sendResponse = vi.fn();

    capturedListener({ code: 'c' }, sender(WEB_APP_ORIGIN), sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'malformed_response' });
    expect(chrome.storage.local._store.sra_session).toBeUndefined();
  });

  it('a network failure degrades to a clear error, never a thrown exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const sendResponse = vi.fn();

    expect(() => capturedListener({ code: 'c' }, sender(WEB_APP_ORIGIN), sendResponse)).not.toThrow();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'network_error' });
  });

  it('a response body that is not JSON at all is rejected, not thrown — same as session.js\'s exchangeCode()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } })));
    const sendResponse = vi.fn();

    expect(() => capturedListener({ code: 'c' }, sender(WEB_APP_ORIGIN), sendResponse)).not.toThrow();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'malformed_response' });
  });
});

describe('a missing expiresAt still stores the session, with the same generous fallback session.js uses', () => {
  it('falls forward by more than 30 days rather than expiring almost immediately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sessionToken: 't', kind: 'extension' }) })));
    const sendResponse = vi.fn();
    const before = Date.now();

    capturedListener({ code: 'c' }, sender(WEB_APP_ORIGIN), sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    const stored = chrome.storage.local._store.sra_session;
    expect(stored.expiresAt).toBeGreaterThan(before);
    expect(stored.expiresAt - before).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
  });
});
