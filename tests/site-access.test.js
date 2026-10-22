import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadBoth() {
  const ctx = { self: {}, URL };
  vm.runInNewContext(readFileSync(new URL('../alcoia/src/shared/sensitive-sites.js', import.meta.url), 'utf8'), ctx);
  vm.runInNewContext(readFileSync(new URL('../alcoia/src/shared/site-access.js', import.meta.url), 'utf8'), ctx);
  return { S: ctx.self.AlcoiaSensitiveSites, A: ctx.self.AlcoiaSiteAccess };
}
const { S, A } = loadBoth();

function fakeChrome({ origins = [], registered = [], userList = [] } = {}) {
  const calls = [];
  const state = { origins: origins.slice(), registered: registered.slice() };
  const c = {
    permissions: {
      getAll: async () => ({ origins: state.origins }),
      contains: async ({ origins: o }) => o.every((x) => state.origins.includes(x)),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    storage: {
      local: { get: (d, cb) => cb({ sra_sensitive_sites: userList }) },
      onChanged: { addListener: vi.fn() },
    },
    scripting: {
      getRegisteredContentScripts: async () => state.registered,
      registerContentScripts: async (r) => { calls.push(['register', r]); state.registered = r; },
      updateContentScripts: async (r) => { calls.push(['update', r]); state.registered = r; },
      unregisterContentScripts: async (o) => { calls.push(['unregister', o]); state.registered = []; },
      executeScript: async (o) => { calls.push(['execute', o]); },
    },
  };
  return { c, calls, state };
}

describe('originPattern', () => {
  it('uses the host only, for http and https', () => {
    expect(A.originPattern('https://blog.example.com:8443/post?x=1')).toBe('*://blog.example.com/*');
    expect(A.originPattern('http://example.com/')).toBe('*://example.com/*');
  });
  it('refuses other schemes', () => {
    expect(A.originPattern('file:///tmp/a.pdf')).toBe(null);
    expect(A.originPattern('chrome://extensions')).toBe(null);
    expect(A.originPattern('nonsense')).toBe(null);
  });
});

describe('buildRegistration', () => {
  it('registers nothing when nothing is granted', () => {
    expect(A.buildRegistration([], S, [])).toBe(null);
    expect(A.buildRegistration(['https://server.alcoia.app/*', 'https://alcoia.app/*'], S, [])).toBe(null);
  });

  it('registers just the granted sites', () => {
    const r = A.buildRegistration(['*://blog.example.com/*', 'https://workspace.alcoia.app/*'], S, []);
    expect(r.matches).toEqual(['http://blog.example.com/*', 'https://blog.example.com/*']);
    expect(r.js).toEqual(['src/shared/config.js', 'src/shared/sensitive-sites.js', 'src/content/content.js']);
    expect(r.allFrames).toBe(false);
  });

  it('registers every web page when all sites are granted, but not local files', () => {
    const r = A.buildRegistration(['<all_urls>'], S, []);
    expect(r.matches).toEqual(['http://*/*', 'https://*/*']);
    expect(r.matches).not.toContain('<all_urls>');
  });

  it('adds local files only when that was granted', () => {
    expect(A.buildRegistration(['file:///*'], S, []).matches).toEqual(['file:///*']);
  });

  it('always excludes the sensitive lists, the reader\'s own sites and alcoia infrastructure', () => {
    const r = A.buildRegistration(['<all_urls>'], S, ['myemployer.com']);
    expect(r.excludeMatches).toContain('*://*.mail.google.com/*');
    expect(r.excludeMatches).toContain('*://*.chase.com/*');
    expect(r.excludeMatches).toContain('*://*.myemployer.com/*');
    expect(r.excludeMatches).toContain('https://console.alcoia.app/*');
  });
});

describe('sync', () => {
  it('registers a script after a site is granted and updates it after', async () => {
    const f = fakeChrome({ origins: ['*://blog.example.com/*'] });
    const sa = A.create({ chromeApi: f.c, sensitiveApi: S });
    expect((await sa.sync()).registered).toBe(true);
    expect(f.calls[0][0]).toBe('register');
    f.state.origins.push('*://other.org/*');
    await sa.sync();
    expect(f.calls[1][0]).toBe('update');
    expect(f.calls[1][1][0].matches).toContain('https://other.org/*');
  });

  it('removes the script once the last permission is withdrawn', async () => {
    const f = fakeChrome({ origins: ['*://blog.example.com/*'] });
    const sa = A.create({ chromeApi: f.c, sensitiveApi: S });
    await sa.sync();
    f.state.origins = [];
    const r = await sa.sync();
    expect(r.registered).toBe(false);
    expect(f.calls.at(-1)[0]).toBe('unregister');
  });

  it('does nothing when there is nothing to remove', async () => {
    const f = fakeChrome();
    const sa = A.create({ chromeApi: f.c, sensitiveApi: S });
    await sa.sync();
    expect(f.calls).toEqual([]);
  });

  it('puts the reader\'s own list into the exclusions', async () => {
    const f = fakeChrome({ origins: ['<all_urls>'], userList: ['myemployer.com'] });
    await A.create({ chromeApi: f.c, sensitiveApi: S }).sync();
    expect(f.calls[0][1][0].excludeMatches).toContain('*://*.myemployer.com/*');
  });

  it('reports a registration failure instead of throwing', async () => {
    const f = fakeChrome({ origins: ['<all_urls>'] });
    f.c.scripting.registerContentScripts = async () => { throw new Error('nope'); };
    const r = await A.create({ chromeApi: f.c, sensitiveApi: S }).sync();
    expect(r.ok).toBe(false);
  });
});

describe('access checks and injection', () => {
  it('knows whether a site is switched on', async () => {
    const f = fakeChrome({ origins: ['*://blog.example.com/*'] });
    const sa = A.create({ chromeApi: f.c, sensitiveApi: S });
    expect(await sa.hasAccessTo('https://blog.example.com/a')).toBe(true);
    expect(await sa.hasAccessTo('https://other.org/a')).toBe(false);
    expect(await sa.hasAccessTo('https://workspace.alcoia.app/a/1')).toBe(true);
  });

  it('treats all-sites as access to any site', async () => {
    const f = fakeChrome({ origins: ['<all_urls>'] });
    expect(await A.create({ chromeApi: f.c, sensitiveApi: S }).hasAccessTo('https://other.org/')).toBe(true);
  });

  it('injects the same files into the open tab', async () => {
    const f = fakeChrome();
    expect(await A.create({ chromeApi: f.c, sensitiveApi: S }).injectNow(7)).toBe(true);
    expect(f.calls[0][1]).toEqual({ target: { tabId: 7 }, files: A.CONTENT_FILES });
  });
});
