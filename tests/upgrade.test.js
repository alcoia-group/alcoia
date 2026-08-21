// @vitest-environment jsdom
/* upgrade.js — the plans page's Reader-tier checkout (item E3). Loads the
 * REAL upgrade.html body into jsdom (not a hand-copied fragment), same
 * reasoning as tests/account.test.js and tests/popup-account.test.js:
 * upgrade.js does plain document.getElementById lookups at module top
 * level and would throw on a missing element, which is exactly the guard
 * this buys.
 *
 * upgrade.js constructs its own session/entitlements/billing managers
 * internally (no injection seam, matching how account.js already works) —
 * so every scenario here is driven through the same chrome.storage/fetch
 * surface a real browser would use, not by mocking this file's internals.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPGRADE_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'popup', 'upgrade.html',
);

const ENTITLEMENTS_URL = 'https://api.alcoia.invalid/api/entitlements';
const CHECKOUT_URL = 'https://api.alcoia.invalid/api/billing/checkout';
const PORTAL_URL = 'https://api.alcoia.invalid/api/billing/portal';

function loadUpgradeBody(search = '') {
  const html = fs.readFileSync(UPGRADE_HTML_PATH, 'utf8');
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('upgrade.html body not found — did its structure change?');
  document.body.innerHTML = match[1].replace(/<script[\s\S]*?<\/script>/g, '');
  if (search) window.history.pushState({}, '', '/upgrade.html' + search);
  else window.history.pushState({}, '', '/upgrade.html');
}

function fakeChrome(seed = {}) {
  const store = { ...seed };
  const tabsCreated = [];
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
      onChanged: { addListener: () => {} },
    },
    tabs: { create: (opts) => { tabsCreated.push(opts); } },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p, lastError: undefined },
    _store: store,
    _tabsCreated: tabsCreated,
  };
}

function fakeConfig() {
  return {
    SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
    SESSION_STORAGE_KEY: 'sra_session',
    ENTITLEMENTS_URL,
    BILLING_CHECKOUT_URL: CHECKOUT_URL,
    BILLING_PORTAL_URL: PORTAL_URL,
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

async function importFreshUpgradeJs() {
  const url = '../alcoia/src/popup/upgrade.js?t=' + Date.now() + Math.random();
  await import(/* @vite-ignore */ url);
  document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
}

const VALID_SESSION = { token: 'tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 };
const FREE_RESPONSE = { tier: 'free', features: [], expires: null };
const READER_RESPONSE = { tier: 'reader', features: ['own_documents', 'portable_receipt', 'sync'], expires: null };

describe('signed-out click routes through sign-in and resumes checkout after', () => {
  it('upgrade.js: a signed-out click stores the pending plan and navigates to account.html', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome());
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', vi.fn());

    await importFreshUpgradeJs();
    document.getElementById('readerBtn').click();

    await vi.waitFor(() => expect(chrome._store.sra_pending_checkout).toBeTruthy());
    expect(chrome._store.sra_pending_checkout.plan).toBe('reader');
    expect(typeof chrome._store.sra_pending_checkout.at).toBe('number');
    // jsdom does not implement cross-document navigation (`Not
    // implemented: navigation to another Document`), so location.href
    // cannot be asserted on directly here — the pending-checkout write
    // above (what actually has to survive the navigation) is the
    // functionally important assertion; the navigation itself is a
    // one-line `location.href = 'account.html'` in upgrade.js.
  });
});

describe('signed-in click opens a new tab with the confirmed checkout URL field', () => {
  it('calls POST /api/billing/checkout and opens the returned checkout_url in a real tab', async () => {
    loadUpgradeBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })],
      [CHECKOUT_URL, async (url, init) => {
        expect(JSON.parse(init.body)).toEqual({ plan: 'reader' });
        expect(init.headers.Authorization).toBe('Bearer tok-1');
        return { ok: true, json: async () => ({ checkout_url: 'https://creem.test/session/abc' }) };
      }],
    ]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('readerBtn').textContent).toBe('Subscribe'));

    document.getElementById('readerBtn').click();

    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    expect(chrome._tabsCreated[0]).toEqual({ url: 'https://creem.test/session/abc' });
  });
});

describe('return-from-checkout without a confirmed webhook shows "processing", not "upgraded"', () => {
  it('landing with ?checkout=pending, still free on refresh, shows the processing note — never the current-plan state', async () => {
    loadUpgradeBody('?checkout=pending');
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })],
    ]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('readerStateNote').hidden).toBe(false));

    expect(document.getElementById('readerStateNote').textContent).toMatch(/processing/i);
    expect(document.getElementById('readerStateNote').textContent).not.toMatch(/you're on the reader plan/i);
    expect(document.getElementById('readerBtn').hidden).toBe(false);
    expect(document.getElementById('manageBtn').hidden).toBe(true);
  });
});

describe('once entitlements.refresh() reports the new plan, the page reflects it without a manual reload', () => {
  it('a refocus after the plan actually changed server-side flips straight to the current-plan state', async () => {
    loadUpgradeBody('?checkout=pending');
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    let plan = FREE_RESPONSE;
    const entitlementsFetch = vi.fn(async () => ({ ok: true, json: async () => plan }));
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, entitlementsFetch]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('readerStateNote').textContent).toMatch(/processing/i));
    const callsBeforeRefocus = entitlementsFetch.mock.calls.length;

    // The plan changed server-side (the webhook landed); the reader
    // switches back to this tab.
    plan = READER_RESPONSE;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(document.getElementById('readerBtn').hidden).toBe(true));
    expect(document.getElementById('manageBtn').hidden).toBe(false);
    expect(document.getElementById('readerStateNote').textContent).toMatch(/you're on the reader plan/i);
    // Confirms this is entitlements.js's own refresh() actually running
    // (item E1/E3's own requirement) — a genuinely new network call, not
    // the 15-minute cache being silently reused or a hand-rolled second
    // implementation.
    expect(entitlementsFetch.mock.calls.length).toBeGreaterThan(callsBeforeRefocus);
  });

  it('a refocus while no checkout was ever initiated does not spuriously refresh', async () => {
    loadUpgradeBody(); // no ?checkout=pending
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    const entitlementsFetch = vi.fn(async () => ({ ok: true, json: async () => FREE_RESPONSE }));
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, entitlementsFetch]]));

    await importFreshUpgradeJs();
    // readerBtn's markup already SAYS "Subscribe" before any JS runs, so
    // waiting on its text is not a reliable "the async render settled"
    // signal — wait on the fetch itself having actually happened instead.
    await vi.waitFor(() => expect(entitlementsFetch).toHaveBeenCalled());
    const callsAfterInitialRender = entitlementsFetch.mock.calls.length;

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 10));

    expect(entitlementsFetch.mock.calls.length).toBe(callsAfterInitialRender);
  });
});

describe('resuming checkout after signing in (account.js -> upgrade.html handoff)', () => {
  it('landing with ?checkout=pending and already signed in shows the processing state immediately, no refocus needed', async () => {
    loadUpgradeBody('?checkout=pending');
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('readerStateNote').hidden).toBe(false));
    expect(document.getElementById('readerStateNote').textContent).toMatch(/processing/i);
    expect(document.getElementById('readerBtn').disabled).toBe(true);
  });
});

describe('Student checkout — same entitlement as Reader, confirmed server-side before wiring', () => {
  it('a signed-out click on "start checkout" stores plan: student and routes to account.html, same as Reader', async () => {
    loadUpgradeBody();
    const chrome = fakeChrome();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', vi.fn());

    await importFreshUpgradeJs();
    document.getElementById('studentBtn').click();

    await vi.waitFor(() => expect(chrome._store.sra_pending_checkout).toBeTruthy());
    expect(chrome._store.sra_pending_checkout.plan).toBe('student');
  });

  it('a signed-in click POSTs plan: student (never reader) and opens the returned checkout_url in a real tab', async () => {
    loadUpgradeBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([
      [ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })],
      [CHECKOUT_URL, async (url, init) => {
        expect(JSON.parse(init.body)).toEqual({ plan: 'student' });
        return { ok: true, json: async () => ({ checkout_url: 'https://creem.test/session/student-abc' }) };
      }],
    ]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('studentBtn').hidden).toBe(false));

    document.getElementById('studentBtn').click();

    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBe(1));
    expect(chrome._tabsCreated[0]).toEqual({ url: 'https://creem.test/session/student-abc' });
  });

  it('once entitled (by EITHER checkout), the Student action hides too — same entitlement, no second "current plan" state', async () => {
    loadUpgradeBody('?checkout=pending');
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => READER_RESPONSE })]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('readerBtn').hidden).toBe(true));

    expect(document.getElementById('studentBtn').hidden).toBe(true);
    expect(document.getElementById('studentStateNote').hidden).toBe(true);
    expect(document.getElementById('manageBtn').hidden).toBe(false);
  });

  it('while a checkout is processing (from either button), the Student action is disabled too, not just Reader\'s', async () => {
    loadUpgradeBody('?checkout=pending');
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('studentStateNote').hidden).toBe(false));

    expect(document.getElementById('studentStateNote').textContent).toMatch(/processing/i);
    expect(document.getElementById('studentBtn').disabled).toBe(true);
  });
});
