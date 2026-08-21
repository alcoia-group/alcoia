// @vitest-environment jsdom
/* account.js — the sign-in screen (item S3). Loads the REAL account.html
 * body into jsdom (not a hand-copied fragment) so this test cannot drift
 * from what actually ships — account.js does plain document.getElementById
 * lookups at module top level and would throw on a missing element, which
 * is exactly the guard this buys. Exercises the real ES module import, the
 * same way tests/host.test.js and tests/background-session.test.js
 * exercise their own real files through fake chrome/fetch globals rather
 * than re-implementing the logic under test.
 *
 * This specific test file exists because the item-S3-follow-up task that
 * restored `email` to the exchange response explicitly asked for proof
 * that the signed-in state renders a REAL address, not a placeholder or
 * "undefined" — the earlier gap (email silently absent from
 * session.getSession()) would have shown up here as blank text, not a
 * thrown error, which is exactly the kind of failure a green test suite
 * can hide (the project notes §2's "this suite's failure mode is absence, not
 * error").
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'popup', 'account.html',
);

function loadAccountBody() {
  const html = fs.readFileSync(ACCOUNT_HTML_PATH, 'utf8');
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('account.html body not found — did its structure change?');
  // Strip the trailing <script> tag — this test imports account.js itself
  // via a real dynamic import, not by letting the browser load it from a
  // <script> tag jsdom does not execute here anyway.
  document.body.innerHTML = match[1].replace(/<script[\s\S]*?<\/script>/g, '');
}

function fakeChrome(seed = {}) {
  const store = { ...seed };
  const tabsCreated = [];
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
      // Item E3's tests need to actually fire this — captures every
      // registered listener so a test can simulate a storage change (a
      // session appearing) the same way tests/background-session.test.js
      // captures onMessageExternal's listener.
      onChanged: {
        addListener: (fn) => { onChangedListeners.push(fn); },
        _fire: (changes, areaName = 'local') => { for (const fn of onChangedListeners) fn(changes, areaName); },
      },
    },
    tabs: { create: (opts) => { tabsCreated.push(opts); } },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p, lastError: undefined },
    _store: store,
    _tabsCreated: tabsCreated,
  };
}

function fakeConfig(extra = {}) {
  return {
    SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
    MAGIC_LINK_REQUEST_URL: 'https://api.alcoia.invalid/api/auth/magic-link',
    EXTENSION_SESSION_EXCHANGE_URL: 'https://api.alcoia.invalid/api/auth/extension-session/exchange',
    SESSION_STORAGE_KEY: 'sra_session',
    ENTITLEMENTS_URL: 'https://api.alcoia.invalid/api/entitlements',
    BILLING_CHECKOUT_URL: 'https://api.alcoia.invalid/api/billing/checkout',
    BILLING_PORTAL_URL: 'https://api.alcoia.invalid/api/billing/portal',
    ...extra,
  };
}

async function importFreshAccountJs() {
  // Each test needs its own top-level render() run against its own DOM/
  // chrome stub — bust the module cache so account.js's side effects
  // (including its own module-scope `session` instance) run again.
  const url = '../alcoia/src/popup/account.js?t=' + Date.now() + Math.random();
  await import(/* @vite-ignore */ url);
}

beforeEach(() => {
  loadAccountBody();
});

describe('the signed-in state renders the real email end to end', () => {
  it('a session with a genuine, unusual email displays exactly that address, not blank or "undefined"', async () => {
    const chrome = fakeChrome({
      sra_session: {
        token: 'sess-real-token',
        email: 'genuinely.distinct+reader@example.org',
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      },
    });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', vi.fn());

    await importFreshAccountJs();
    await vi.waitFor(() => expect(document.getElementById('signedInState').hidden).toBe(false));

    const emailEl = document.getElementById('signedInEmail');
    expect(emailEl.textContent).toBe('genuinely.distinct+reader@example.org');
    expect(emailEl.textContent).not.toBe('');
    expect(emailEl.textContent).not.toMatch(/undefined/i);
    expect(document.getElementById('signInForm').hidden).toBe(true);
  });

  it('no session at all shows the sign-in form, not a stale or blank signed-in state', async () => {
    const chrome = fakeChrome({});
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', vi.fn());

    await importFreshAccountJs();
    await vi.waitFor(() => expect(document.getElementById('signInForm').hidden).toBe(false));
    expect(document.getElementById('signedInState').hidden).toBe(true);
  });
});

describe('resuming a checkout started while signed out (item E3)', () => {
  it('a fresh pending-checkout intent, once a session appears, starts checkout and opens the returned URL in a new tab', async () => {
    const chrome = fakeChrome({
      sra_pending_checkout: { plan: 'reader', at: Date.now() },
    });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.alcoia.invalid/api/billing/checkout');
      expect(JSON.parse(init.body)).toEqual({ plan: 'reader' });
      return { ok: true, json: async () => ({ checkout_url: 'https://creem.test/session/resumed' }) };
    });
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshAccountJs();

    // Simulate the session appearing (background.js's handoff completing)
    // — the exact event account.js's own listener reacts to.
    chrome._store.sra_session = { token: 'tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 };
    await chrome.storage.onChanged._fire({ sra_session: { newValue: chrome._store.sra_session } });

    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    expect(chrome._tabsCreated[0]).toEqual({ url: 'https://creem.test/session/resumed' });
    // The intent is consumed, not left to resume again on some later,
    // unrelated sign-in.
    expect(chrome._store.sra_pending_checkout).toBeUndefined();
  });

  it('an expired pending-checkout intent (older than 10 minutes) is discarded, never silently resumed', async () => {
    const chrome = fakeChrome({
      sra_pending_checkout: { plan: 'reader', at: Date.now() - 11 * 60 * 1000 },
    });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshAccountJs();
    chrome._store.sra_session = { token: 'tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 };
    await chrome.storage.onChanged._fire({ sra_session: { newValue: chrome._store.sra_session } });

    // Give the async listener a turn to run before asserting nothing happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(chrome._tabsCreated.length).toBe(0);
    expect(chrome._store.sra_pending_checkout).toBeUndefined();
    const checkoutCalls = fetchImpl.mock.calls.filter(([url]) => url.includes('/billing/checkout'));
    expect(checkoutCalls.length).toBe(0);
  });

  it('no pending checkout at all: a session appearing does not touch billing endpoints', async () => {
    const chrome = fakeChrome({});
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/api/entitlements')) return { ok: true, json: async () => ({ tier: 'free', features: [], expires: null }) };
      throw new Error('unexpected fetch to ' + url);
    });
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshAccountJs();
    chrome._store.sra_session = { token: 'tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 };
    await chrome.storage.onChanged._fire({ sra_session: { newValue: chrome._store.sra_session } });

    await new Promise((r) => setTimeout(r, 20));
    expect(chrome._tabsCreated.length).toBe(0);
  });
});
