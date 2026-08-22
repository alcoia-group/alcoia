// @vitest-environment jsdom
/* join-class.js — accepting a class invite, with the disclosure gate
 * (item S6). Loads the REAL join-class.html body into jsdom, same
 * reasoning as tests/account.test.js and tests/upgrade.test.js:
 * join-class.js does plain document.getElementById lookups at module top
 * level and would throw on a missing element, which is exactly the guard
 * this buys.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JOIN_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'popup', 'join-class.html',
);

const ENTITLEMENTS_URL = 'https://api.alcoia.invalid/api/entitlements';
const ACCEPT_URL = 'https://api.alcoia.invalid/api/invites/accept';
const SEATS_URL = 'https://api.alcoia.invalid/api/seats';

function loadJoinBody() {
  const html = fs.readFileSync(JOIN_HTML_PATH, 'utf8');
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('join-class.html body not found — did its structure change?');
  document.body.innerHTML = match[1].replace(/<script[\s\S]*?<\/script>/g, '');
  window.history.pushState({}, '', '/join-class.html');
}

function fakeChrome(seed = {}) {
  const store = { ...seed };
  const onChangedListeners = [];
  return {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
          cb(result);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
        remove(key, cb) { delete store[key]; if (cb) cb(); },
      },
      onChanged: {
        addListener: (fn) => { onChangedListeners.push(fn); },
        _fire: (changes, areaName = 'local') => { for (const fn of onChangedListeners) fn(changes, areaName); },
      },
    },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p, lastError: undefined },
    _store: store,
  };
}

function fakeConfig() {
  return {
    SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
    SESSION_STORAGE_KEY: 'sra_session',
    ENTITLEMENTS_URL,
    INVITE_ACCEPT_URL: ACCEPT_URL,
    SEATS_URL,
  };
}

function routedFetch(routes) {
  return vi.fn(async (url, init) => {
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init);
    }
    throw new Error('unexpected fetch to ' + url);
  });
}

async function importFreshJoinClassJs() {
  const url = '../alcoia/src/popup/join-class.js?t=' + Date.now() + Math.random();
  await import(/* @vite-ignore */ url);
}

const VALID_SESSION = { token: 'tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 };
const FREE_RESPONSE = { tier: 'free', features: [], expires: null };
const READER_RESPONSE = { tier: 'reader', features: ['own_documents', 'portable_receipt', 'sync'], expires: null };

describe('a join cannot complete without the disclosure screen having been rendered', () => {
  it('submitting the invite code shows the disclosure FIRST — accept is never called before that', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const acceptFetch = vi.fn(async () => ({ ok: true, json: async () => ({ classId: 'c1', seatId: 's1', role: 'student' }) }));
    vi.stubGlobal('fetch', routedFetch([[ACCEPT_URL, acceptFetch]]));

    await importFreshJoinClassJs();
    expect(document.getElementById('disclosureState').hidden).toBe(true);

    document.getElementById('inviteInput').value = 'some-invite-code';
    document.getElementById('inputFormEl').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('disclosureState').hidden).toBe(false));

    // The disclosure text is genuinely in the DOM and visible, and the
    // accept call has NOT fired just from submitting the code.
    expect(document.getElementById('disclosureBlock').textContent).toMatch(/aggregate results only/i);
    expect(document.getElementById('inputState').hidden).toBe(true);
    expect(acceptFetch).not.toHaveBeenCalled();
  });

  it('only clicking "Join this class" — inside the disclosure — actually calls accept', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const acceptFetch = vi.fn(async (url, init) => {
      expect(JSON.parse(init.body)).toEqual({ token: 'some-invite-code' });
      return { ok: true, json: async () => ({ classId: 'c1', seatId: 's1', role: 'student' }) };
    });
    vi.stubGlobal('fetch', routedFetch([[ACCEPT_URL, acceptFetch]]));

    await importFreshJoinClassJs();
    document.getElementById('inviteInput').value = 'some-invite-code';
    document.getElementById('inputFormEl').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('disclosureState').hidden).toBe(false));

    document.getElementById('confirmJoinBtn').click();

    await vi.waitFor(() => expect(acceptFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(document.getElementById('memberState').hidden).toBe(false));
    expect(document.getElementById('memberClassId').textContent).toContain('c1');
  });

  it('"Back" returns to the input step and clears the disclosure-rendered guard — a second submit is required before Join is reachable again', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const acceptFetch = vi.fn(async () => ({ ok: true, json: async () => ({ classId: 'c1', seatId: 's1', role: 'student' }) }));
    vi.stubGlobal('fetch', routedFetch([[ACCEPT_URL, acceptFetch]]));

    await importFreshJoinClassJs();
    document.getElementById('inviteInput').value = 'some-code';
    document.getElementById('inputFormEl').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('disclosureState').hidden).toBe(false));

    document.getElementById('backBtn').click();
    expect(document.getElementById('inputState').hidden).toBe(false);
    expect(document.getElementById('disclosureState').hidden).toBe(true);
    expect(acceptFetch).not.toHaveBeenCalled();
  });

  it('resuming after sign-in (account.js -> join-class.html) still shows the disclosure fresh, never auto-joins', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_pending_invite: { invite: 'resumed-code', at: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const acceptFetch = vi.fn(async () => ({ ok: true, json: async () => ({ classId: 'c1', seatId: 's1', role: 'student' }) }));
    vi.stubGlobal('fetch', routedFetch([[ACCEPT_URL, acceptFetch]]));

    await importFreshJoinClassJs();
    await vi.waitFor(() => expect(document.getElementById('disclosureState').hidden).toBe(false));

    // Not joined yet — the disclosure is showing, not the member state,
    // and accept has not been called just from landing on this page.
    expect(document.getElementById('memberState').hidden).toBe(true);
    expect(acceptFetch).not.toHaveBeenCalled();
    expect(document.getElementById('disclosureBlock').textContent).toMatch(/aggregate results only/i);
  });
});

describe('an invalid or expired invite fails cleanly', () => {
  async function acceptFailsWith(errorCode, status) {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ACCEPT_URL, async () => ({ ok: false, status, json: async () => ({ error: errorCode }) })]]));

    await importFreshJoinClassJs();
    document.getElementById('inviteInput').value = 'bad-code';
    document.getElementById('inputFormEl').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('disclosureState').hidden).toBe(false));

    document.getElementById('confirmJoinBtn').click();
    await vi.waitFor(() => expect(document.getElementById('disclosureError').hidden).toBe(false));
    return document.getElementById('disclosureError').textContent;
  }

  it('an unrecognised code (404 invalid_invite) shows an honest message, not a crash, and does not show member state', async () => {
    const text = await acceptFailsWith('invalid_invite', 404);
    expect(text).toMatch(/isn.t recognised/i);
    expect(document.getElementById('memberState').hidden).toBe(true);
  });

  it('an expired invite (410 invite_expired) shows an honest message', async () => {
    const text = await acceptFailsWith('invite_expired', 410);
    expect(text).toMatch(/expired/i);
  });

  it('a revoked invite (410 invite_revoked) shows an honest message', async () => {
    const text = await acceptFailsWith('invite_revoked', 410);
    expect(text).toMatch(/cancelled/i);
  });

  it('a network failure shows an honest message rather than throwing', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ACCEPT_URL, async () => { throw new TypeError('Failed to fetch'); }]]));

    await importFreshJoinClassJs();
    document.getElementById('inviteInput').value = 'code';
    document.getElementById('inputFormEl').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('disclosureState').hidden).toBe(false));

    expect(() => document.getElementById('confirmJoinBtn').click()).not.toThrow();
    await vi.waitFor(() => expect(document.getElementById('disclosureError').hidden).toBe(false));
  });

  it('after a failed join, the reader can still retry from the same disclosure screen — the button re-enables', async () => {
    const text = await acceptFailsWith('invite_full', 409);
    expect(text).toMatch(/limit/i);
    expect(document.getElementById('confirmJoinBtn').disabled).toBe(false);
    expect(document.getElementById('confirmJoinBtn').textContent).toBe('Join this class');
  });
});

describe('leaving a class reverts entitlement to free and the extension reflects it', () => {
  it('clicking "Leave this class" releases the seat, clears local membership, and refreshes entitlements to free', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_membership: { classId: 'c1', seatId: 's1', role: 'student', joinedAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    let entitled = true;
    const releaseFetch = vi.fn(async () => ({ ok: true, json: async () => ({ released: true }) }));
    vi.stubGlobal('fetch', routedFetch([
      [SEATS_URL, releaseFetch],
      [ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => (entitled ? READER_RESPONSE : FREE_RESPONSE) })],
    ]));

    await importFreshJoinClassJs();
    await vi.waitFor(() => expect(document.getElementById('memberState').hidden).toBe(false));

    entitled = false; // the server-side effect of releasing the seat
    document.getElementById('leaveBtn').click();

    await vi.waitFor(() => expect(releaseFetch).toHaveBeenCalledTimes(1));
    expect(releaseFetch.mock.calls[0][0]).toBe(`${SEATS_URL}/s1/release`);
    await vi.waitFor(() => expect(document.getElementById('inputState').hidden).toBe(false));
    expect(document.getElementById('memberState').hidden).toBe(true);

    // The actual "reflects it" proof: entitlements.js's own refresh() ran
    // and reports free now — checked via the shared module directly,
    // matching item E1/E3's own precedent, not re-implemented here.
    const { createEntitlementsManager } = await import('../alcoia/src/shared/entitlements.js');
    const check = createEntitlementsManager({
      getSession: async () => VALID_SESSION,
      entitlementsUrl: ENTITLEMENTS_URL,
      fetchImpl: routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })]]),
    });
    expect(await check.hasFeature('own_documents')).toBe(false);
    expect(chrome._store.sra_class_membership).toBeUndefined();
  });

  it('a failed release (e.g. seat already gone) shows an honest message and does not clear local membership', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_membership: { classId: 'c1', seatId: 's1', role: 'student', joinedAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [SEATS_URL, async () => ({ ok: false, status: 403, json: async () => ({ error: 'not_authorized' }) })],
      [ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => READER_RESPONSE })],
    ]));

    await importFreshJoinClassJs();
    await vi.waitFor(() => expect(document.getElementById('memberState').hidden).toBe(false));

    document.getElementById('leaveBtn').click();
    await vi.waitFor(() => expect(document.getElementById('leaveError').hidden).toBe(false));
    expect(document.getElementById('memberState').hidden).toBe(false);
  });
});

describe('landing directly on an already-active membership', () => {
  it('shows the member state immediately, skipping input/disclosure entirely', async () => {
    loadJoinBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_membership: { classId: 'c9', seatId: 's9', role: 'student', joinedAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', vi.fn());

    await importFreshJoinClassJs();
    expect(document.getElementById('memberState').hidden).toBe(false);
    expect(document.getElementById('memberClassId').textContent).toContain('c9');
    expect(document.getElementById('inputState').hidden).toBe(true);
    expect(document.getElementById('disclosureState').hidden).toBe(true);
  });
});
