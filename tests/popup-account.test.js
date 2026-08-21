// @vitest-environment jsdom
/* popup.js's new "Account" section (item S3 follow-up). Loads the REAL
 * popup.html body into jsdom — popup.js is a large, plain (non-module)
 * script that does dozens of unguarded document.getElementById lookups
 * across its whole DOMContentLoaded handler, so a hand-built DOM fragment
 * covering only the account section would either throw on missing
 * elements or silently drift from what actually ships. This test does not
 * attempt to cover popup.js's other, unrelated wiring (tabs, toggles,
 * quiz gate, etc.) — only that its account-status read renders a real
 * email, the same proof-of-fix tests/account.test.js provides for the
 * sign-in screen itself.
 *
 * popup.js's own logic lives entirely inside a `DOMContentLoaded`
 * listener; jsdom's own DOMContentLoaded has already fired by the time
 * this file's code runs (the document is parsed once, synchronously, at
 * environment setup), so this test dispatches a synthetic one after
 * importing the script — dispatchEvent does not care whether an earlier
 * dispatch of the same type already happened, it just invokes whatever is
 * currently registered.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POPUP_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'popup', 'popup.html',
);

function loadPopupBody() {
  const html = fs.readFileSync(POPUP_HTML_PATH, 'utf8');
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('popup.html body not found — did its structure change?');
  document.body.innerHTML = match[1].replace(/<script[\s\S]*?<\/script>/g, '');
}

function fakeChrome(seed = {}) {
  const store = { ...seed };
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
    tabs: {
      query: (_opts, cb) => cb([{ id: 1 }]),
      sendMessage: (_id, _msg, cb) => { cb && cb(undefined); },
      create: () => {},
    },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p, lastError: undefined, sendMessage: () => {} },
    _store: store,
  };
}

async function importFreshPopupJs() {
  const url = '../alcoia/src/popup/popup.js?t=' + Date.now() + Math.random();
  await import(/* @vite-ignore */ url);
  document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
}

describe('popup.js\'s Account section renders the real email end to end', () => {
  it('a signed-in session shows "Signed in as [real email]", not blank or "undefined"', async () => {
    loadPopupBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: {
        token: 'sess-real-token',
        email: 'genuinely.distinct+reader@example.org',
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', { SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize' });

    await importFreshPopupJs();
    await vi.waitFor(() => expect(document.getElementById('accountSignedIn').hidden).toBe(false));

    const emailEl = document.getElementById('accountEmail');
    expect(emailEl.textContent).toBe('genuinely.distinct+reader@example.org');
    expect(emailEl.textContent).not.toMatch(/undefined/i);
    expect(document.getElementById('accountSignedOut').hidden).toBe(true);
  });

  it('no session shows the signed-out state, not a stale or blank signed-in one', async () => {
    loadPopupBody();
    vi.stubGlobal('chrome', fakeChrome({}));
    vi.stubGlobal('ALCOIA_CONFIG', { SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize' });

    await importFreshPopupJs();
    await vi.waitFor(() => expect(document.getElementById('accountSignedOut').hidden).toBe(false));
    expect(document.getElementById('accountSignedIn').hidden).toBe(true);
  });

  it('an expired session reads as signed-out here too — never the presence-only check', async () => {
    loadPopupBody();
    vi.stubGlobal('chrome', fakeChrome({
      sra_session: { token: 'stale', email: 'old@example.com', expiresAt: Date.now() - 1000 },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', { SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize' });

    await importFreshPopupJs();
    await vi.waitFor(() => expect(document.getElementById('accountSignedOut').hidden).toBe(false));
    expect(document.getElementById('accountSignedIn').hidden).toBe(true);
  });

  it('sign-out clears the session and reverts the section to signed-out', async () => {
    loadPopupBody();
    const chrome = fakeChrome({
      sra_session: { token: 't', email: 'reader@example.com', expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000 },
    });
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('ALCOIA_CONFIG', { SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize' });

    await importFreshPopupJs();
    await vi.waitFor(() => expect(document.getElementById('accountSignedIn').hidden).toBe(false));

    document.getElementById('signOutBtn').click();

    await vi.waitFor(() => expect(document.getElementById('accountSignedOut').hidden).toBe(false));
    expect(document.getElementById('accountSignedIn').hidden).toBe(true);
    expect(chrome._store.sra_session).toBeUndefined();
  });
});
