// @vitest-environment jsdom
/* The worker's second check: a request that carries page text to the server is refused when it comes from a
 * banking, email, health or password-manager page, or one the reader added to their own list. The page script
 * already stays off there; this is the check on the one path every text-sending request takes. */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

let onMessage = null;
let installedListener = null;
const registered = [];

function read(p) { return readFileSync(new URL('../alcoia/' + p, import.meta.url), 'utf8'); }

beforeAll(async () => {
  window.eval(read('src/shared/sensitive-sites.js'));
  window.eval(read('src/shared/site-access.js'));
  const store = { };
  vi.stubGlobal('chrome', {
    tabs: { onUpdated: { addListener() {} }, create: vi.fn(), update() {}, sendMessage() {} },
    storage: {
      local: {
        _store: store,
        get(keys, cb) { const r = {}; for (const [k, d] of Object.entries(keys || {})) r[k] = k in store ? store[k] : d; cb(r); },
        set(o, cb) { Object.assign(store, o); cb && cb(); },
        remove(k, cb) { delete store[k]; cb && cb(); },
      },
      onChanged: { addListener() {} },
    },
    permissions: {
      getAll: async () => ({ origins: ['*://blog.example.com/*'] }),
      contains: async () => true,
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async (r) => { registered.push(...r); },
      updateContentScripts: async () => {},
      unregisterContentScripts: async () => {},
      executeScript: vi.fn(async () => {}),
    },
    runtime: {
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      onMessageExternal: { addListener() {} },
      onInstalled: { addListener: (fn) => { installedListener = fn; } },
      getURL: (p) => 'chrome-extension://test/' + p,
      lastError: undefined,
    },
  });
  vi.stubGlobal('ALCOIA_CONFIG', {
    WEB_APP_ORIGIN: 'https://alcoia.app', LTI_READER_ORIGIN: 'https://alcoia.app',
    EXTENSION_SESSION_EXCHANGE_URL: 'https://server.alcoia.invalid/x', SESSION_STORAGE_KEY: 'sra_session',
    SUMMARIZE_URL: 'https://server.alcoia.invalid/api/summarize',
  });
  await import('../alcoia/background.js');
});

beforeEach(() => {
  for (const k of Object.keys(chrome.storage.local._store)) delete chrome.storage.local._store[k];
});

function send(msg, tabUrl) {
  return new Promise((resolve) => {
    const ret = onMessage(msg, tabUrl ? { tab: { id: 1, url: tabUrl } } : {}, resolve);
    if (ret !== true) resolve(undefined);
  });
}

describe('text-sending requests from sensitive pages', () => {
  it.each(['https://mail.google.com/mail/u/0/', 'https://www.chase.com/personal', 'https://my.bitwarden.com/#/vault', 'https://www.mychart.com/'])(
    'refuses apiPost from %s without touching the network',
    async (url) => {
      const f = vi.fn(); vi.stubGlobal('fetch', f);
      const r = await send({ action: 'apiPost', url: 'https://server.alcoia.invalid/api/questions', token: 't', body: { text: 'secret' } }, url);
      expect(r).toEqual({ ok: false, error: 'sensitive_site' });
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('refuses summarize and proxyFetch from a sensitive page too', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect((await send({ action: 'summarize', token: 't', body: {} }, 'https://paypal.com/x')).error).toBe('sensitive_site');
    expect((await send({ action: 'proxyFetch', url: 'https://server.alcoia.invalid/a', options: {} }, 'https://paypal.com/x')).error).toBe('sensitive_site');
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a page the reader added to their own list', async () => {
    chrome.storage.local._store.sra_sensitive_sites = ['myemployer.com'];
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    const r = await send({ action: 'apiPost', url: 'https://server.alcoia.invalid/q', token: 't', body: {} }, 'https://hr.myemployer.com/review');
    expect(r.error).toBe('sensitive_site');
    expect(f).not.toHaveBeenCalled();
  });

  it('still serves an ordinary page', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ q: 1 }) }));
    vi.stubGlobal('fetch', f);
    const r = await send({ action: 'apiPost', url: 'https://server.alcoia.invalid/q', token: 't', body: { text: 'hi' } }, 'https://en.wikipedia.org/wiki/Reading');
    expect(r).toEqual({ ok: true, data: { q: 1 } });
    expect(f).toHaveBeenCalledOnce();
  });

  it('still serves an extension page, which has no site address to judge', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', f);
    const r = await send({ action: 'proxyFetch', url: 'https://server.alcoia.invalid/a', options: {} }, null);
    expect(r.ok).toBe(true);
  });
});

describe('site access messages', () => {
  it('re-registers the script and injects into the open tab when a site is switched on', async () => {
    const r = await send({ action: 'siteAccessChanged', tabId: 5 }, null);
    expect(r.ok).toBe(true);
    expect(r.injected).toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 5 }, files: expect.arrayContaining(['src/content/content.js']) });
    expect(registered.at(-1).matches).toContain('https://blog.example.com/*');
  });

  it('does not inject when a site is switched off', async () => {
    chrome.scripting.executeScript.mockClear();
    const r = await send({ action: 'siteAccessChanged', tabId: 5, inject: false }, null);
    expect(r.injected).toBe(false);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('opens the welcome page on a fresh install, not on an update', () => {
    chrome.tabs.create.mockClear();
    installedListener({ reason: 'update' });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    installedListener({ reason: 'install' });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://test/src/popup/welcome.html' });
  });
});
