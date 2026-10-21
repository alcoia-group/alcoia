// @vitest-environment jsdom
/* host.js: connections to the reader's own workspace documents on an ordinary page. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHost } from '../alcoia/src/content/host.js';
import { createUIController } from '../alcoia/src/content/ui-controller.js';

const loadModule = (p) => import(/* @vite-ignore */ `../alcoia/${p}`);
const DOCS = [{ kind: 'assignment', id: 'a1', title: 'Energy reading', url_path: '/a/a1', concepts: [{ label: 'Gradient descent', description: '' }] }];
const PARAGRAPHS = [
  'The gradient descent method is widely used to train models in practice today.',
  'In this section gradient descent is compared with other optimisation methods on a benchmark.',
  'We show that gradient descent converges quickly under mild conditions on the loss function.',
];

let proxied;
function fakeChrome(store) {
  return {
    storage: {
      local: {
        get(keys, cb) { const r = {}; for (const [k, d] of Object.entries(keys || {})) r[k] = k in store ? store[k] : d; cb(r); },
        set(obj, cb) { Object.assign(store, obj); cb && cb(); },
        remove(k, cb) { delete store[k]; cb && cb(); },
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      sendMessage: vi.fn((msg, cb) => {
        if (msg.action === 'proxyFetch') {
          proxied.push(msg);
          if (msg.url.endsWith('/api/entitlements')) cb({ ok: true, status: 200, data: { tier: 'reader', features: ['cross_document_intelligence'] } });
          else if (msg.url.endsWith('/api/account/document-concepts')) cb({ ok: true, status: 200, data: { documents: DOCS } });
          else cb({ ok: true, status: 200, data: {} });
          return;
        }
        cb({ ok: true, data: { summary: 'x', questions: [] } });
      }),
      getURL: (p) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
  };
}

async function setup({ signedIn = true, showConnections = true, assistantEnabled = true } = {}) {
  const store = { sra_install_token: 't' };
  if (signedIn) store.sra_session = { token: 'sess-1', email: 'a@example.com', expiresAt: Date.now() + 1e9 };
  vi.stubGlobal('chrome', fakeChrome(store));
  vi.stubGlobal('ALCOIA_CONFIG', {
    SUMMARIZE_URL: 'https://api.test.invalid/api/summarize', TOKEN_URL: 'https://api.test.invalid/api/token',
    ENTITLEMENTS_URL: 'https://api.test.invalid/api/entitlements',
    DOCUMENT_CONCEPTS_URL: 'https://api.test.invalid/api/account/document-concepts',
    READER_ORIGIN: 'https://workspace.alcoia.app', QUESTION_LEVELS_SUPPORTED: ['recognition'],
  });
  const onConnections = vi.fn();
  const settings = { assistantEnabled, backendUrl: 'https://api.test.invalid/api/summarize', showConnections };
  const created = await createHost({
    loadModule, ui: createUIController({}), esc: (s) => String(s), log: () => {}, warn: () => {},
    settings: () => settings, onConnections,
  });
  return { ...created, onConnections, settings };
}
const read = async (host) => {
  for (const [i, text] of PARAGRAPHS.entries()) { host.onParagraphRead(text, 5000, i); await new Promise((r) => setTimeout(r, 0)); }
};

beforeEach(() => { proxied = []; document.body.innerHTML = ''; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('connections on an ordinary page', () => {
  it('reports the matching workspace document once the idea has appeared in enough paragraphs', async () => {
    const { host, onConnections } = await setup();
    await read(host);
    await vi.waitFor(() => expect(onConnections).toHaveBeenCalled());
    const list = onConnections.mock.calls.at(-1)[0];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Energy reading', href: 'https://workspace.alcoia.app/a/a1', label: 'Gradient descent' });
  });

  it('sends nothing about the page: the only requests are the plan check and the document list, both with just the token', async () => {
    const { host, onConnections } = await setup();
    await read(host);
    await vi.waitFor(() => expect(onConnections).toHaveBeenCalled());
    expect(proxied.map((m) => m.url).sort()).toEqual(['https://api.test.invalid/api/account/document-concepts', 'https://api.test.invalid/api/entitlements']);
    for (const m of proxied) {
      expect(m.options.method).toBe('GET');
      expect(m.options.body).toBeUndefined();
      expect(Object.keys(m.options.headers)).toEqual(['Authorization']);
    }
    expect(JSON.stringify(proxied)).not.toMatch(/gradient|paragraph|benchmark/i);
  });

  it('does nothing when signed out', async () => {
    const { host, onConnections } = await setup({ signedIn: false });
    await read(host);
    await new Promise((r) => setTimeout(r, 30));
    expect(onConnections).not.toHaveBeenCalledWith(expect.arrayContaining([expect.anything()]));
    expect(proxied).toHaveLength(0);
  });

  it('does nothing when "Show connections to my documents" is off, or the extension is off', async () => {
    for (const opts of [{ showConnections: false }, { assistantEnabled: false }]) {
      proxied = [];
      const { host, onConnections } = await setup(opts);
      await read(host);
      await new Promise((r) => setTimeout(r, 30));
      expect(onConnections).not.toHaveBeenCalled();
      expect(proxied).toHaveLength(0);
    }
  });

  it('shows no card: nothing is rendered on the page', async () => {
    const { host, onConnections } = await setup();
    await read(host);
    await vi.waitFor(() => expect(onConnections).toHaveBeenCalled());
    expect(document.querySelectorAll('[data-alcoia-host]').length).toBe(0);
  });

  it('is held back while reminders are snoozed', async () => {
    const { host, onConnections } = await setup();
    chrome.storage.local.set({ sra_snooze_until: Date.now() + 3_600_000 });
    await read(host);
    await new Promise((r) => setTimeout(r, 50));
    expect(onConnections).not.toHaveBeenCalledWith(expect.arrayContaining([expect.anything()]));
  });
});
