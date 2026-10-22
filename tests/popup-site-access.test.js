// @vitest-environment jsdom
/* The popup's per-site switch. alcoia reads nothing on a site until it is switched on, and the browser's own
 * permission prompt is the only thing that grants it. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

const rd = (p) => fs.readFileSync(new URL('../alcoia/' + p, import.meta.url), 'utf8');

function loadPopupBody() {
  const html = rd('src/popup/popup.html');
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
}

function fakeChrome({ url, granted = [], allowRequest = true, userList = [] }) {
  const origins = granted.slice();
  const sent = [];
  const c = {
    storage: {
      local: {
        get(keys, cb) { const r = {}; for (const [k, d] of Object.entries(keys || {})) r[k] = k === 'sra_sensitive_sites' ? userList : d; cb(r); },
        set(o, cb) { cb && cb(); },
      },
      onChanged: { addListener() {} },
    },
    tabs: { query: (_o, cb) => cb([{ id: 3, url, title: 'T' }]), sendMessage: (_i, _m, cb) => { cb && cb(undefined); }, create() {} },
    permissions: {
      contains: vi.fn((p, cb) => cb(p.origins.every((o) => origins.includes(o)))),
      request: vi.fn((p, cb) => { if (allowRequest) origins.push(...p.origins); cb(allowRequest); }),
      remove: vi.fn((p, cb) => { for (const o of p.origins) { const i = origins.indexOf(o); if (i >= 0) origins.splice(i, 1); } cb(true); }),
    },
    runtime: { getURL: (p) => 'chrome-extension://t/' + p, lastError: undefined, sendMessage: (m, cb) => { if (m && m.action === 'siteAccessChanged') sent.push(m); cb && cb({ ok: true }); } },
    _sent: sent,
  };
  return c;
}

async function open(opts) {
  loadPopupBody();
  window.eval(rd('src/shared/sensitive-sites.js'));
  window.eval(rd('src/shared/site-access.js'));
  const c = fakeChrome(opts);
  vi.stubGlobal('chrome', c);
  vi.stubGlobal('ALCOIA_CONFIG', { SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize' });
  await import(/* @vite-ignore */ '../alcoia/src/popup/popup.js?t=' + Math.random());
  document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.getElementById('siteCard').hidden).toBe(false));
  return c;
}
const $ = (id) => document.getElementById(id);
const flip = (on) => { $('siteToggle').checked = on; $('siteToggle').dispatchEvent(new Event('change', { bubbles: true })); };

beforeEach(() => { document.body.innerHTML = ''; });

describe('the per-site switch', () => {
  it('starts off on a site that has not been switched on, and says which site', async () => {
    await open({ url: 'https://blog.example.com/post' });
    expect($('siteHost').textContent).toBe('blog.example.com');
    expect($('siteToggle').checked).toBe(false);
    expect($('siteToggleWrap').hidden).toBe(false);
    expect($('siteNote').textContent).toMatch(/Off here/);
  });

  it('asks the browser for that one site, then has the worker register and inject', async () => {
    const c = await open({ url: 'https://blog.example.com/post' });
    flip(true);
    // earlier tests in this file left their popup scripts listening on the same document, so a click can
    // be handled more than once; what matters is what was sent
    await vi.waitFor(() => expect(c._sent.length).toBeGreaterThan(0));
    expect(c.permissions.request).toHaveBeenCalledWith({ origins: ['*://blog.example.com/*'] }, expect.any(Function));
    expect(c._sent).toContainEqual({ action: 'siteAccessChanged', tabId: 3 });
    expect($('siteToggle').checked).toBe(true);
    expect($('siteNote').textContent).toMatch(/this site only/);
  });

  it('never asks for all sites from the per-site switch', async () => {
    const c = await open({ url: 'https://blog.example.com/post' });
    flip(true);
    await vi.waitFor(() => expect(c.permissions.request).toHaveBeenCalled());
    expect(JSON.stringify(c.permissions.request.mock.calls)).not.toMatch(/all_urls/);
  });

  it('goes back to off, and tells the worker nothing to inject, if the browser says no', async () => {
    const c = await open({ url: 'https://blog.example.com/post', allowRequest: false });
    flip(true);
    await vi.waitFor(() => expect($('siteNote').textContent).toMatch(/Not switched on/));
    expect($('siteToggle').checked).toBe(false);
    expect(c._sent).toEqual([]);
  });

  it('shows a site that is already switched on, and turning it off withdraws only that permission', async () => {
    const c = await open({ url: 'https://blog.example.com/post', granted: ['*://blog.example.com/*'] });
    expect($('siteToggle').checked).toBe(true);
    flip(false);
    await vi.waitFor(() => expect(c._sent.length).toBeGreaterThan(0));
    expect(c.permissions.remove).toHaveBeenCalledWith({ origins: ['*://blog.example.com/*'] }, expect.any(Function));
    expect(c._sent).toContainEqual({ action: 'siteAccessChanged', tabId: 3, inject: false });
    expect(c._sent.every((m) => m.inject === false)).toBe(true);
    expect($('siteNote').textContent).toMatch(/Reload/);
  });

  it('shows all-sites as on and locked, pointing to Settings', async () => {
    await open({ url: 'https://blog.example.com/post', granted: ['<all_urls>'] });
    expect($('siteToggle').checked).toBe(true);
    expect($('siteToggle').disabled).toBe(true);
    expect($('siteNote').textContent).toMatch(/Settings/);
  });
});

describe('pages with no switch', () => {
  it.each([
    ['https://mail.google.com/mail', /banking, payment, email, health and password/],
    ['https://www.chase.com/', /banking, payment, email, health and password/],
  ])('%s: no switch, says why, asks for nothing', async (url, re) => {
    const c = await open({ url });
    expect($('siteToggleWrap').hidden).toBe(true);
    expect($('siteNote').textContent).toMatch(re);
    expect(c.permissions.request).not.toHaveBeenCalled();
  });

  it('a site on the reader\'s own list is treated the same way', async () => {
    await open({ url: 'https://hr.myemployer.com/x', userList: ['myemployer.com'] });
    expect($('siteToggleWrap').hidden).toBe(true);
  });

  it('alcoia\'s own sites always work', async () => {
    await open({ url: 'https://workspace.alcoia.app/a/1' });
    expect($('siteToggleWrap').hidden).toBe(true);
    expect($('siteNote').textContent).toMatch(/always works/);
  });

  it('local files point to Settings', async () => {
    await open({ url: 'file:///home/me/paper.pdf' });
    expect($('siteToggleWrap').hidden).toBe(true);
    expect($('siteNote').textContent).toMatch(/Settings/);
  });
});
