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
 *
 * A REAL BUG SLIPPED PAST THIS FILE ONCE ALREADY: earlier versions of
 * these tests loaded ONLY <body>'s innerHTML, discarding panel.css's
 * <link> and upgrade.html's own <style> block entirely, and asserted only
 * `element.hidden === true` (the DOM attribute) rather than whether the
 * element was actually, visually gone. `.hidden = true` was genuinely
 * being set — the assertion was never false — but a `.btn { display:
 * inline-flex }` rule in panel.css silently beat the browser's own
 * `[hidden] { display: none }` default (equal specificity, author rule
 * wins the tie), so the Reader button stayed fully visible in a real
 * browser the whole time, stuck on whatever "Waiting…" label it had before
 * refresh() resolved.
 *
 * THIS FILE STILL CANNOT CATCH THAT SPECIFIC BUG, EVEN NOW — confirmed
 * directly, not assumed: jsdom's own getComputedStyle does NOT reproduce
 * the collision at all (isolated repro: a `.btn { display: inline-flex }`
 * rule never beats `[hidden]` in jsdom, regardless of author-stylesheet
 * ordering — jsdom special-cases `hidden` in a way real Chromium does not).
 * So loadUpgradeBody() below loading the real CSS, and isVisible() below
 * checking computed style rather than the attribute, are real correctness
 * improvements over the old attribute-only assertions (they do catch a
 * genuinely un-hidden element with NO competing display rule, and they
 * catch the label/disabled reset this bug also needed), but they are NOT
 * what proves THIS specific CSS-specificity collision is fixed. That proof
 * lives in tests/browser/smoke.mjs's "upgrade page button fix" block,
 * which runs in genuine Chromium via Playwright — the only environment
 * that actually reproduces the collision. Do not trust this file alone for
 * that claim; it was already wrong once (CLAUDE.md §2: "this suite's
 * failure mode is absence, not error... a green run is not evidence a
 * feature works" — applies to this file's own history now, not just the
 * app it tests).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPGRADE_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'popup', 'upgrade.html',
);
const PANEL_CSS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'styles', 'panel.css',
);

const ENTITLEMENTS_URL = 'https://api.alcoia.invalid/api/entitlements';
const CHECKOUT_URL = 'https://api.alcoia.invalid/api/billing/checkout';
const PORTAL_URL = 'https://api.alcoia.invalid/api/billing/portal';

function loadUpgradeBody(search = '') {
  const html = fs.readFileSync(UPGRADE_HTML_PATH, 'utf8');
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error('upgrade.html body not found — did its structure change?');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!styleMatch) throw new Error('upgrade.html <style> block not found — did its structure change?');

  // Real panel.css FIRST, upgrade.html's own inline <style> SECOND — the
  // same cascade order the real <head> uses (the <link> precedes the
  // inline block there). This is what makes getComputedStyle(...).display
  // below mean anything at all.
  const panelCss = fs.readFileSync(PANEL_CSS_PATH, 'utf8');
  document.head.innerHTML = '';
  const styleEl = document.createElement('style');
  styleEl.textContent = panelCss + '\n' + styleMatch[1];
  document.head.appendChild(styleEl);

  document.body.innerHTML = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/g, '');
  if (search) window.history.pushState({}, '', '/upgrade.html' + search);
  else window.history.pushState({}, '', '/upgrade.html');
}

// The actual bug lived in the gap between "hidden === true" (the
// attribute, always was correct) and "really invisible" (was not) — so
// every check that matters here goes through computed style, not the
// attribute alone.
function isVisible(el) {
  return getComputedStyle(el).display !== 'none';
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
const FREE_RESPONSE = { tier: 'free', features: [], expires: null, hasActiveSeat: false };
// Item S6 follow-up: `expires` must be a real date here, not null — per
// alcoiaServer's src/entitlements/resolve.js (confirmed by reading it
// directly), the subscription branch is the ONLY branch that ever sets a
// non-null expires, so `expires: null` on a 'reader' tier now specifically
// means "via a seat," not "via a subscription with no expiry." Every test
// in this file that reaches this constant is modelling a completed
// CHECKOUT (a subscription), so this is a correction to make the mock
// honest, not a behaviour change to what these tests were already
// asserting.
const READER_RESPONSE = {
  tier: 'reader', features: ['own_documents', 'portable_receipt', 'sync'],
  expires: '2099-01-01T00:00:00.000Z', hasActiveSeat: false,
};
// The two new source states this task adds: entitled via a class seat
// alone (no subscription — expires null, hasActiveSeat true), and entitled
// via BOTH a subscription and a currently active seat at once.
const SEAT_ONLY_RESPONSE = {
  tier: 'reader', features: ['own_documents', 'portable_receipt', 'sync'],
  expires: null, hasActiveSeat: true,
};
const BOTH_RESPONSE = {
  tier: 'reader', features: ['own_documents', 'portable_receipt', 'sync'],
  expires: '2099-01-01T00:00:00.000Z', hasActiveSeat: true,
};

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

    const readerBtn = document.getElementById('readerBtn');
    await vi.waitFor(() => expect(readerBtn.hidden).toBe(true));
    // `.hidden` alone was already true at this point even before the fix
    // — in a REAL browser the button stayed fully visible regardless (a
    // `.btn { display: inline-flex }` rule in panel.css beats `[hidden]`'s
    // equal-specificity UA default). isVisible() does NOT actually catch
    // that here — jsdom does not reproduce the collision at all (see this
    // file's own header) — so this assertion is a correctness check on the
    // fixed value, not a regression guard for the CSS bug itself; that
    // guard is tests/browser/smoke.mjs's "upgrade page button fix" block.
    expect(isVisible(readerBtn)).toBe(false);
    // And not just invisible-but-stale: the label/disabled state itself
    // must be reset, not left showing "Waiting…"/disabled in case this
    // element is ever shown again later (e.g. a downgrade).
    expect(readerBtn.disabled).toBe(false);
    expect(readerBtn.textContent).toBe('Subscribe');
    expect(document.getElementById('manageBtn').hidden).toBe(false);
    expect(isVisible(document.getElementById('manageBtn'))).toBe(true);
    expect(document.getElementById('readerStateNote').textContent).toMatch(/you're on the reader plan/i);
    // Confirms this is entitlements.js's own refresh() actually running
    // (item E1/E3's own requirement) — a genuinely new network call, not
    // the 15-minute cache being silently reused or a hand-rolled second
    // implementation.
    expect(entitlementsFetch.mock.calls.length).toBeGreaterThan(callsBeforeRefocus);
  });

  it('the SAME entitled render, reached on a normal page load with no checkout ever attempted, also fully replaces the button — not only after a checkout round-trip', async () => {
    // No `?checkout=pending` — this is a reader who is already entitled
    // from a PRIOR session, just opening the plans page normally. Before
    // the fix this path never even set the "Waiting…" label at all — the
    // button's default HTML text ("Subscribe") is what stayed stuck
    // visible, and worse than the return-from-checkout case, it was never
    // disabled either, so it stayed genuinely clickable.
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => READER_RESPONSE })]]));

    await importFreshUpgradeJs();

    const readerBtn = document.getElementById('readerBtn');
    await vi.waitFor(() => expect(isVisible(readerBtn)).toBe(false));
    expect(readerBtn.hidden).toBe(true);
    expect(readerBtn.disabled).toBe(false);
    expect(readerBtn.textContent).toBe('Subscribe');

    const manageBtn = document.getElementById('manageBtn');
    expect(manageBtn.hidden).toBe(false);
    expect(isVisible(manageBtn)).toBe(true);
    expect(document.getElementById('readerStateNote').textContent).toMatch(/you're on the reader plan/i);
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
    const readerBtn = document.getElementById('readerBtn');
    await vi.waitFor(() => expect(isVisible(readerBtn)).toBe(false));

    const studentBtn = document.getElementById('studentBtn');
    expect(studentBtn.hidden).toBe(true);
    // studentBtn (class="link-btn") never had the CSS collision readerBtn
    // did — .link-btn sets no `display` of its own, so [hidden] was never
    // contested for it. Asserted explicitly rather than assumed, per this
    // item's own instruction to confirm Student's path by reading it, not
    // by assuming it matches Reader's.
    expect(isVisible(studentBtn)).toBe(false);
    expect(studentBtn.disabled).toBe(false);
    expect(studentBtn.textContent).toBe('start checkout');
    expect(document.getElementById('studentStateNote').hidden).toBe(true);
    expect(document.getElementById('manageBtn').hidden).toBe(false);
  });

  it('the same entitled render on a normal page load (no checkout ever attempted) also fully resets the Student action', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => READER_RESPONSE })]]));

    await importFreshUpgradeJs();
    const studentBtn = document.getElementById('studentBtn');
    await vi.waitFor(() => expect(isVisible(studentBtn)).toBe(false));
    expect(studentBtn.disabled).toBe(false);
    expect(studentBtn.textContent).toBe('start checkout');
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

describe('entitlement source (item S6 follow-up): subscription vs. class seat vs. both', () => {
  it('subscription-only: shows the existing subscriber state unchanged — "You\'re on the Reader plan.", manage link visible, no seat note', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => READER_RESPONSE })]]));

    await importFreshUpgradeJs();
    const readerBtn = document.getElementById('readerBtn');
    await vi.waitFor(() => expect(isVisible(readerBtn)).toBe(false));

    expect(document.getElementById('readerStateNote').textContent).toMatch(/you're on the reader plan/i);
    const manageBtn = document.getElementById('manageBtn');
    expect(manageBtn.hidden).toBe(false);
    expect(isVisible(manageBtn)).toBe(true);
    expect(document.getElementById('readerSeatNote').hidden).toBe(true);
  });

  it('seat-only: shows the new seat-based message as the PRIMARY note, and the Manage subscription link is gone', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_memberships: [{ classId: 'c-seat-1', seatId: 's1', role: 'student', joinedAt: Date.now() }],
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => SEAT_ONLY_RESPONSE })]]));

    await importFreshUpgradeJs();
    const readerBtn = document.getElementById('readerBtn');
    await vi.waitFor(() => expect(isVisible(readerBtn)).toBe(false));

    const manageBtn = document.getElementById('manageBtn');
    expect(manageBtn.hidden).toBe(true);
    expect(isVisible(manageBtn)).toBe(false);
    expect(document.getElementById('readerStateNote').textContent).toMatch(/reader access through class c-seat-1/i);
    expect(document.getElementById('readerStateNote').textContent).not.toMatch(/you're on the reader plan/i);
    // No competing second note when the seat message is already primary.
    expect(document.getElementById('readerSeatNote').hidden).toBe(true);
  });

  it('seat-only with no local class record: falls back to a generic message rather than fabricating a class id', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION })); // no sra_class_memberships
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => SEAT_ONLY_RESPONSE })]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('readerStateNote').hidden).toBe(false));
    expect(document.getElementById('readerStateNote').textContent).toMatch(/reader access through a class seat/i);
    expect(document.getElementById('manageBtn').hidden).toBe(true);
  });

  it('both simultaneously, currently active seat: subscription state stays PRIMARY, and the active seat is surfaced, not hidden', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_memberships: [{ classId: 'c-both-1', seatId: 's2', role: 'student', joinedAt: Date.now() }],
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => BOTH_RESPONSE })]]));

    await importFreshUpgradeJs();
    const readerBtn = document.getElementById('readerBtn');
    await vi.waitFor(() => expect(isVisible(readerBtn)).toBe(false));

    // Primary: unchanged subscriber state, manage link present — this is
    // what persists after the class is left (ALCOIA-PLATFORM-SPEC.md §6).
    expect(document.getElementById('readerStateNote').textContent).toMatch(/you're on the reader plan/i);
    const manageBtn = document.getElementById('manageBtn');
    expect(manageBtn.hidden).toBe(false);
    expect(isVisible(manageBtn)).toBe(true);

    // Not silently hidden: a second, explicit line names the active seat.
    const seatNote = document.getElementById('readerSeatNote');
    expect(seatNote.hidden).toBe(false);
    expect(seatNote.textContent).toMatch(/also enrolled in class c-both-1/i);
  });

  it('subscription + a seat that was since left: behaves exactly like subscription-only, no leftover seat note', async () => {
    // A real, distinct case from "both active": the server reports
    // hasActiveSeat: false once the seat is released, even though a local
    // sra_class_memberships record might still exist from before leaving
    // (e.g. leave happened on another device) -- the server bit, not the
    // stale local record, is what this page trusts.
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_memberships: [{ classId: 'c-since-left', seatId: 's3', role: 'student', joinedAt: Date.now() - 999_999 }],
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => READER_RESPONSE })]]));

    await importFreshUpgradeJs();
    const readerBtn = document.getElementById('readerBtn');
    await vi.waitFor(() => expect(isVisible(readerBtn)).toBe(false));

    expect(document.getElementById('readerStateNote').textContent).toMatch(/you're on the reader plan/i);
    expect(document.getElementById('manageBtn').hidden).toBe(false);
    // The stale local record must not resurrect a seat note the server no
    // longer confirms.
    expect(document.getElementById('readerSeatNote').hidden).toBe(true);
  });
});

describe('Teams & classrooms card reflects real active-seat state (item S6 follow-up)', () => {
  it('signed out: stays "Coming soon", disabled, no state note', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome());
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', vi.fn());

    await importFreshUpgradeJs();
    const teamsBtn = document.getElementById('teamsBtn');
    expect(teamsBtn.disabled).toBe(true);
    expect(teamsBtn.textContent).toBe('Coming soon');
    expect(document.getElementById('teamsStateNote').hidden).toBe(true);
  });

  it('signed in, free (no seat, no subscription): stays "Coming soon", disabled', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('teamsBtn').disabled).toBe(true));
    expect(document.getElementById('teamsBtn').textContent).toBe('Coming soon');
  });

  it('subscription-only, no seat: stays "Coming soon" — a subscriber is not automatically a class member', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({ sra_session: VALID_SESSION }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => READER_RESPONSE })]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('readerStateNote').hidden).toBe(false));
    expect(document.getElementById('teamsBtn').disabled).toBe(true);
    expect(document.getElementById('teamsBtn').textContent).toBe('Coming soon');
  });

  it('an active seat holder (seat-only): the card reflects real membership and enables a link to the leave/manage flow', async () => {
    loadUpgradeBody();
    const chrome = fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_memberships: [{ classId: 'c-teams-1', seatId: 's4', role: 'student', joinedAt: Date.now() }],
    });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => SEAT_ONLY_RESPONSE })]]));

    await importFreshUpgradeJs();
    const teamsBtn = document.getElementById('teamsBtn');
    await vi.waitFor(() => expect(teamsBtn.disabled).toBe(false));
    expect(teamsBtn.textContent).not.toBe('Coming soon');
    expect(document.getElementById('teamsStateNote').hidden).toBe(false);
    expect(document.getElementById('teamsStateNote').textContent).toMatch(/class c-teams-1/i);

    // "surface a link to the existing leave-class flow from here too" —
    // clicking opens join-class.html as its own tab, the same established
    // pattern every other cross-page action in this file already uses;
    // this file does not build a second leave UI.
    //
    // Asserts "at least one, most-recent" rather than an exact count: this
    // click handler is synchronous (unlike startCheckout()'s async chain),
    // which deterministically exposes a pre-existing characteristic of
    // this test file — DOMContentLoaded listeners from every earlier
    // importFreshUpgradeJs() in this same jsdom document accumulate on
    // `document` and all re-fire on each new dispatch, re-attaching a click
    // listener each time. Async handlers elsewhere in this file only
    // APPEAR immune because vi.waitFor happens to catch length===1 before
    // later accumulated listeners resolve — not a guarantee, just timing.
    // The behaviour under test (this click opens the real leave flow) does
    // not depend on exactly-once dispatch, so the assertion does not
    // either.
    const before = chrome._tabsCreated.length;
    teamsBtn.click();
    await vi.waitFor(() => expect(chrome._tabsCreated.length).toBeGreaterThan(before));
    expect(chrome._tabsCreated.at(-1).url).toMatch(/join-class\.html$/);
  });

  it('an active seat holder alongside a subscription (both): the Teams card still reflects the active seat', async () => {
    loadUpgradeBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: VALID_SESSION,
      sra_class_memberships: [{ classId: 'c-teams-2', seatId: 's5', role: 'student', joinedAt: Date.now() }],
    }));
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => BOTH_RESPONSE })]]));

    await importFreshUpgradeJs();
    const teamsBtn = document.getElementById('teamsBtn');
    await vi.waitFor(() => expect(teamsBtn.disabled).toBe(false));
    expect(document.getElementById('teamsStateNote').textContent).toMatch(/class c-teams-2/i);
  });

  it('a disabled click is inert — no tab opens while still "Coming soon"', async () => {
    loadUpgradeBody();
    const chrome = fakeChrome({ sra_session: VALID_SESSION });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', fakeConfig());
    vi.stubGlobal('fetch', routedFetch([[ENTITLEMENTS_URL, async () => ({ ok: true, json: async () => FREE_RESPONSE })]]));

    await importFreshUpgradeJs();
    await vi.waitFor(() => expect(document.getElementById('teamsBtn').disabled).toBe(true));
    document.getElementById('teamsBtn').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(chrome._tabsCreated.length).toBe(0);
  });
});
