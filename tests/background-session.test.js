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
    tabs: { onUpdated: { addListener: () => {} }, create: (opts) => { chrome._tabsCreated.push(opts); }, update: () => {} },
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
    _tabsCreated: [],
  };
}

const WEB_APP_ORIGIN = 'http://localhost:5173';
const EXCHANGE_URL = 'https://api.alcoia.invalid/api/auth/extension-session/exchange';
const LTI_READER_ORIGIN = 'https://console.alcoia.invalid';

beforeAll(async () => {
  vi.stubGlobal('chrome', fakeChromeForImport());
  vi.stubGlobal('ALCOIA_CONFIG', {
    WEB_APP_ORIGIN,
    EXTENSION_SESSION_EXCHANGE_URL: EXCHANGE_URL,
    SESSION_STORAGE_KEY: 'sra_session',
    SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
    LTI_READER_ORIGIN,
  });
  // background.js has no exports — imported once, for its top-level
  // chrome.runtime.onMessageExternal.addListener(...) call, which the fake
  // above captures into `capturedListener`.
  await import('../alcoia/background.js');
  expect(capturedListener).toBeTypeOf('function');
});

beforeEach(() => {
  chrome.storage.local._store = {};
  chrome._tabsCreated.length = 0;
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
  it('a valid code from the allowed origin exchanges and stores the session, email included', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(url).toBe(EXCHANGE_URL);
      expect(JSON.parse(init.body)).toEqual({ code: 'good-code' });
      // The CONFIRMED real shape (alcoiaServer's src/http/routes/
      // extension-session.js, createExtensionSessionRouter's success
      // response, after the item-S3 follow-up that added the account
      // lookup): { sessionToken, email, kind: 'extension', expiresAt:
      // <ISO> }. `email` was confirmed ABSENT in an earlier pass — that
      // route now looks the account up server-side and includes it.
      return { ok: true, json: async () => ({ sessionToken: 'sess-1', email: 'reader@example.com', kind: 'extension', expiresAt: '2099-01-01T00:00:00Z' }) };
    }));
    const sendResponse = vi.fn();

    const keepChannelOpen = capturedListener({ code: 'good-code' }, sender(WEB_APP_ORIGIN), sendResponse);
    expect(keepChannelOpen).toBe(true);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, email: 'reader@example.com' });
    // Stored shape keeps this listener's own field names (token/email/
    // expiresAt) — only the source property read off the response for the
    // token is `sessionToken`.
    expect(chrome.storage.local._store.sra_session).toEqual({
      token: 'sess-1', email: 'reader@example.com', expiresAt: Date.parse('2099-01-01T00:00:00Z'),
    });
  });

  it('a response with the wrong token field name (old "token" instead of "sessionToken") is rejected as malformed', async () => {
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

  it('a response missing email is rejected as malformed, not stored with a blank/undefined email — regression guard for the item-S3 follow-up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionToken: 'sess-1', kind: 'extension', expiresAt: '2099-01-01T00:00:00Z' }),
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sessionToken: 't', email: 'a@b.com', kind: 'extension' }) })));
    const sendResponse = vi.fn();
    const before = Date.now();

    capturedListener({ code: 'c' }, sender(WEB_APP_ORIGIN), sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, email: 'a@b.com' });
    const stored = chrome.storage.local._store.sra_session;
    expect(stored.expiresAt).toBeGreaterThan(before);
    expect(stored.expiresAt - before).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
  });
});

describe('LTI launch handoff (item S6/E4 follow-up) — a second, independently origin-checked message shape', () => {
  it('a disclosureRequired payload from the LTI origin stores the pending record and opens join-class.html — the SAME disclosure screen, not a second one', () => {
    const sendResponse = vi.fn();
    const payload = { disclosureRequired: true, reportingMode: 'aggregate', classId: 'class-1', ackCode: 'ack-abc' };

    const keepOpen = capturedListener({ type: 'ltiLaunch', payload }, sender(LTI_READER_ORIGIN), sendResponse);
    expect(keepOpen).toBe(true);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, disclosureRequired: true });
    expect(chrome.storage.local._store.sra_pending_lti_launch).toMatchObject({
      ackCode: 'ack-abc', classId: 'class-1', reportingMode: 'aggregate',
    });
    expect(typeof chrome.storage.local._store.sra_pending_lti_launch.at).toBe('number');
    // No session and no membership are ever written for this branch — the
    // join has NOT completed, only a pending record that join-class.js's
    // own disclosure-gated completeJoin() can turn into one.
    expect(chrome.storage.local._store.sra_session).toBeUndefined();
    expect(chrome.storage.local._store.sra_class_membership).toBeUndefined();
    expect(chrome._tabsCreated).toEqual([{ url: 'chrome-extension://test/src/popup/join-class.html' }]);
  });

  it('an already-acknowledged launch (sessionToken present, no disclosureRequired) stores the session and membership directly, opens no tab', () => {
    const sendResponse = vi.fn();
    const payload = { sessionToken: 'lti-sess-1', kind: 'lti', classId: 'class-2', assignmentId: 'assign-1', redirectTo: 'https://console.alcoia.invalid/read?classId=class-2' };

    capturedListener({ type: 'ltiLaunch', payload }, sender(LTI_READER_ORIGIN), sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, disclosureRequired: false });
    expect(chrome.storage.local._store.sra_session).toEqual({ token: 'lti-sess-1', email: '', expiresAt: expect.any(Number) });
    expect(chrome.storage.local._store.sra_class_membership).toEqual({ classId: 'class-2', seatId: null, role: null, joinedAt: expect.any(Number) });
    expect(chrome._tabsCreated).toEqual([]);
  });

  it('rejects an LTI-shaped message from any origin other than LTI_READER_ORIGIN — including the magic-link origin', () => {
    const sendResponse = vi.fn();
    const payload = { disclosureRequired: true, reportingMode: 'aggregate', classId: 'class-1', ackCode: 'ack-abc' };

    capturedListener({ type: 'ltiLaunch', payload }, sender(WEB_APP_ORIGIN), sendResponse);

    // Falls through to the magic-link branch, which then rejects it for
    // having no `code` — proving the LTI origin check is real, not just
    // decorative: a message shaped for LTI from the WRONG origin is
    // treated as a (malformed) magic-link attempt, never processed as LTI.
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'no_code' });
    expect(chrome.storage.local._store.sra_pending_lti_launch).toBeUndefined();
    expect(chrome._tabsCreated).toEqual([]);
  });

  it('rejects an LTI-origin message that is missing the ltiLaunch type — does not silently process it as LTI', () => {
    const sendResponse = vi.fn();
    capturedListener({ payload: { disclosureRequired: true, classId: 'c', ackCode: 'a' } }, sender(LTI_READER_ORIGIN), sendResponse);

    // Falls through to the magic-link check, which then rejects this
    // origin (LTI_READER_ORIGIN is not WEB_APP_ORIGIN).
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'origin_not_allowed' });
  });

  it('a malformed disclosureRequired payload (missing ackCode) is rejected cleanly, nothing stored', () => {
    const sendResponse = vi.fn();
    capturedListener(
      { type: 'ltiLaunch', payload: { disclosureRequired: true, classId: 'class-1' } },
      sender(LTI_READER_ORIGIN), sendResponse,
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'malformed_payload' });
    expect(chrome.storage.local._store.sra_pending_lti_launch).toBeUndefined();
    expect(chrome._tabsCreated).toEqual([]);
  });

  it('a payload that matches neither confirmed shape (no disclosureRequired, no sessionToken) is rejected cleanly', () => {
    const sendResponse = vi.fn();
    capturedListener({ type: 'ltiLaunch', payload: { somethingElse: true } }, sender(LTI_READER_ORIGIN), sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'malformed_payload' });
  });

  it('a completely missing payload does not throw', () => {
    const sendResponse = vi.fn();
    expect(() => capturedListener({ type: 'ltiLaunch' }, sender(LTI_READER_ORIGIN), sendResponse)).not.toThrow();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'malformed_payload' });
  });
});
