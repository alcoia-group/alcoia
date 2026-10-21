import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const src = readFileSync(new URL('../alcoia/src/shared/account-sync.js', import.meta.url), 'utf8');
function loadSync() {
  const ctx = { self: {} };
  vm.runInNewContext(src, ctx);
  return ctx.self.AlcoiaAccountSync;
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(keys, cb) {
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      cb(out);
    },
    set(obj, cb) { Object.assign(data, structuredClone(obj)); cb?.(); },
  };
}

function fakeServer({ settings = null, baseline = { status: 'enabled', globalWpm: null, byLanguage: {} }, baselineStatus = 200 } = {}) {
  const calls = [];
  const state = { settings, baseline };
  async function fetchImpl(url, init = {}) {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, auth: init.headers?.Authorization });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (path === '/api/account/settings') {
      if (init.method === 'PUT') { state.settings = { ...(state.settings || {}), ...body }; return json(200, { settings: state.settings, updatedAt: 'now' }); }
      return json(200, state.settings ? { settings: state.settings, updatedAt: 'then' } : { settings: { enabled: true, dark_mode: false }, updatedAt: null });
    }
    if (path === '/api/account/reading-baseline') {
      if (init.method === 'PUT') return baselineStatus === 403 ? json(403, { error: 'learner_memory_consent_required' }) : json(200, { status: 'enabled', ...body });
      return json(200, state.baseline);
    }
    return json(404, null);
  }
  return { fetchImpl, calls, state };
}

const SESSION = { sra_session: { token: 'tok', email: 'a@x', expiresAt: Date.now() + 1e9 } };
let timers;
const fakeTimers = () => {
  timers = [];
  return { setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
};
const runTimers = async () => { while (timers.length) await timers.shift()(); };

describe('account-sync', () => {
  let Sync;
  beforeEach(() => { Sync = loadSync(); });

  it('does nothing while signed out', async () => {
    const server = fakeServer();
    const sync = Sync.create({ storage: memoryStorage({ sra_dark_mode: true }), fetchImpl: server.fetchImpl, backendOrigin: 'https://s', ...fakeTimers() });
    expect(await sync.pull({ force: true })).toEqual({ pulled: false, reason: 'signed_out' });
    await sync.onStorageChanged({ sra_dark_mode: { newValue: false } }, 'local');
    await runTimers();
    expect(server.calls).toEqual([]);
  });

  it('first sign-in on an account with no saved settings sends this device\'s settings up', async () => {
    const server = fakeServer();
    const storage = memoryStorage({ ...SESSION, sra_dark_mode: true, sra_autohide_timeout: 20, sra_dyslexia_color: '' });
    const sync = Sync.create({ storage, fetchImpl: server.fetchImpl, backendOrigin: 'https://s', ...fakeTimers() });
    await sync.pull({ force: true });
    const put = server.calls.find((c) => c.method === 'PUT' && c.path === '/api/account/settings');
    expect(put.body).toEqual({ dark_mode: true, autohide_timeout: 20 }); // an invalid colour stays local
    expect(put.auth).toBe('Bearer tok');
  });

  it('an account with saved settings wins on pull, and writing them back is not sent up again', async () => {
    const server = fakeServer({ settings: { enabled: false, dark_mode: true, autohide_timeout: 30 } });
    const storage = memoryStorage({ ...SESSION, sra_enabled: true, sra_dark_mode: false });
    const sync = Sync.create({ storage, fetchImpl: server.fetchImpl, backendOrigin: 'https://s', ...fakeTimers() });
    await sync.pull({ force: true });
    expect(storage.data).toMatchObject({ sra_enabled: false, sra_dark_mode: true, sra_autohide_timeout: 30 });
    // the echo of those writes
    await sync.onStorageChanged({ sra_enabled: { newValue: false }, sra_dark_mode: { newValue: true } }, 'local');
    await runTimers();
    expect(server.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('a local change is sent up once, batched, only for the closed list of keys', async () => {
    const server = fakeServer({ settings: { dark_mode: false } });
    const storage = memoryStorage({ ...SESSION });
    const sync = Sync.create({ storage, fetchImpl: server.fetchImpl, backendOrigin: 'https://s', ...fakeTimers() });
    await sync.pull({ force: true });
    await sync.onStorageChanged({ sra_dark_mode: { newValue: true }, sra_backend_url: { newValue: 'http://x' } }, 'local');
    await sync.onStorageChanged({ sra_autohide: { newValue: true } }, 'local');
    await runTimers();
    const puts = server.calls.filter((c) => c.method === 'PUT' && c.path === '/api/account/settings');
    expect(puts.map((p) => p.body)).toEqual([{ dark_mode: true, autohide: true }]);
  });

  it('fills missing languages from the account and sends up languages the account lacks', async () => {
    const server = fakeServer({ settings: {}, baseline: { status: 'enabled', globalWpm: 240, byLanguage: { en: 250 } } });
    const storage = memoryStorage({ ...SESSION, sra_baseline_wpm_by_lang: { fr: 200 } });
    const sync = Sync.create({ storage, fetchImpl: server.fetchImpl, backendOrigin: 'https://s', ...fakeTimers() });
    await sync.pull({ force: true });
    expect(storage.data.sra_baseline_wpm_by_lang).toEqual({ fr: 200, en: 250 });
    expect(storage.data.sra_baseline_wpm).toBe(240);
    await runTimers();
    const put = server.calls.find((c) => c.method === 'PUT' && c.path === '/api/account/reading-baseline');
    expect(put.body).toEqual({ globalWpm: 240, byLanguage: { fr: 200, en: 250 } });
    expect(JSON.stringify(put.body)).not.toMatch(/http|text|url/i);
  });

  it('with account-based learning off, the baseline is neither read nor sent', async () => {
    const server = fakeServer({ settings: {}, baseline: { status: 'disabled', globalWpm: null, byLanguage: {} } });
    const storage = memoryStorage({ ...SESSION, sra_baseline_wpm: 230 });
    const sync = Sync.create({ storage, fetchImpl: server.fetchImpl, backendOrigin: 'https://s', ...fakeTimers() });
    await sync.pull({ force: true });
    await sync.onStorageChanged({ sra_baseline_wpm: { newValue: 260 } }, 'local');
    await runTimers();
    expect(server.calls.some((c) => c.method === 'PUT' && c.path === '/api/account/reading-baseline')).toBe(false);
  });

  it('a sign-in pulls straight away', async () => {
    const server = fakeServer({ settings: { dark_mode: true } });
    const storage = memoryStorage({});
    const sync = Sync.create({ storage, fetchImpl: server.fetchImpl, backendOrigin: 'https://s', ...fakeTimers() });
    storage.data.sra_session = SESSION.sra_session;
    await sync.onStorageChanged({ sra_session: { newValue: SESSION.sra_session } }, 'local');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(server.calls[0].path).toBe('/api/account/settings');
  });
});

describe('content.js steps back on a workspace page that runs its own detection', () => {
  const contentSrc = readFileSync(new URL('../alcoia/src/content/content.js', import.meta.url), 'utf8');
  function run({ url, meta }) {
    const dom = new JSDOM(`<!doctype html><html><head>${meta ? '<meta name="alcoia-detection" content="workspace">' : ''}</head><body><p>x</p></body></html>`, { url, runScripts: 'outside-only' });
    const calls = [];
    dom.window.ALCOIA_CONFIG = { READER_ORIGIN: 'https://workspace.alcoia.app', SUMMARIZE_URL: 'https://s/api/summarize' };
    dom.window.chrome = {
      storage: { local: { get: (k, cb) => { calls.push(['get', k]); }, set: () => {} }, onChanged: { addListener: () => calls.push(['listen']) } },
      runtime: { sendMessage: (m) => calls.push(['send', m]), onMessage: { addListener: () => {} }, getURL: (p) => p },
    };
    dom.window.eval(contentSrc);
    return { calls, loaded: !!dom.window.__sra_content_loaded };
  }

  it('does nothing on the workspace origin when the page announces detection', () => {
    const r = run({ url: 'https://workspace.alcoia.app/a/11111111-1111-4111-8111-111111111111', meta: true });
    expect(r.loaded).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('runs as usual on the workspace without the tag (an older workspace build)', () => {
    const r = run({ url: 'https://workspace.alcoia.app/a/x', meta: false });
    expect(r.loaded).toBe(true);
    expect(r.calls.some(([k]) => k === 'get')).toBe(true);
  });

  it('ignores the tag on any other site', () => {
    const r = run({ url: 'https://example.com/article', meta: true });
    expect(r.loaded).toBe(true);
  });
});
