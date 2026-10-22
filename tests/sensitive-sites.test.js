import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const src = readFileSync(new URL('../alcoia/src/shared/sensitive-sites.js', import.meta.url), 'utf8');
function load() {
  const ctx = { self: {}, URL };
  vm.runInNewContext(src, ctx);
  return ctx.self.AlcoiaSensitiveSites;
}
const S = load();
const page = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

describe('built-in sensitive hosts', () => {
  it.each([
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com', 'app.proton.me',
    'www.chase.com', 'secure.bankofamerica.com', 'online.wellsfargo.com', 'www.paypal.com', 'checkout.stripe.com',
    'my.bitwarden.com', 'vault.1password.com', 'www.mychart.com', 'login.microsoftonline.com',
    'webmail.school.edu', 'onlinebanking.somebank.co.nz', 'www.hsbc.co.uk',
  ])('treats %s as sensitive', (host) => {
    expect(S.isSensitiveHost(host)).toBe(true);
  });

  it.each([
    'www.google.com', 'en.wikipedia.org', 'arxiv.org', 'news.ycombinator.com', 'health.harvard.edu',
    'purchase.com', 'notpaypal.com', 'chase.com.example.org', 'blog.example.com', 'alcoia.app', 'workspace.alcoia.app',
  ])('leaves %s alone', (host) => {
    expect(S.isSensitiveHost(host)).toBe(false);
  });

  it('matches whole labels, never a longer name that ends the same way', () => {
    expect(S.isSensitiveHost('mychase.com')).toBe(false);
    expect(S.isSensitiveHost('notchase.com')).toBe(false);
    expect(S.isSensitiveHost('a.chase.com')).toBe(true);
  });

  it('ignores case and a trailing dot', () => {
    expect(S.isSensitiveHost('MAIL.Google.COM.')).toBe(true);
  });

  it('covers every major category', () => {
    const d = S.BUILTIN_DOMAINS;
    for (const must of ['mail.google.com', 'paypal.com', 'chase.com', 'mychart.com', '1password.com', 'bitwarden.com']) {
      expect(d).toContain(must);
    }
  });
});

describe('the reader\'s own list', () => {
  it('adds sites and their subdomains', () => {
    expect(S.isSensitiveHost('portal.myemployer.com', ['myemployer.com'])).toBe(true);
    expect(S.isSensitiveHost('myemployer.com', ['myemployer.com'])).toBe(true);
    expect(S.isSensitiveHost('other.com', ['myemployer.com'])).toBe(false);
  });

  it('accepts addresses pasted in any shape', () => {
    expect(S.normalizeUserEntry('https://www.Example.com/some/path?q=1')).toBe('example.com');
    expect(S.normalizeUserEntry('*.example.com')).toBe('example.com');
    expect(S.normalizeUserEntry('example.com:8080')).toBe('example.com');
    expect(S.normalizeUserEntry('  ')).toBe(null);
    expect(S.normalizeUserEntry('not a site')).toBe(null);
    expect(S.normalizeUserEntry('com')).toBe(null);
  });

  it('ignores junk entries rather than throwing', () => {
    expect(S.isSensitiveHost('example.com', [null, 5, '', 'nope nope'])).toBe(false);
  });
});

describe('page fields', () => {
  it('flags a page with a password field', () => {
    expect(S.pageHasSensitiveFields(page('<form><input type="password"></form>'))).toBe(true);
    expect(S.pageHasSensitiveFields(page('<input type="PASSWORD">'))).toBe(true);
  });

  it('flags a card-number style field', () => {
    expect(S.pageHasSensitiveFields(page('<input autocomplete="cc-number">'))).toBe(true);
    expect(S.pageHasSensitiveFields(page('<input name="cardNumber">'))).toBe(true);
    expect(S.pageHasSensitiveFields(page('<input id="card_number" type="text">'))).toBe(true);
    expect(S.pageHasSensitiveFields(page('<input placeholder="CVV">'))).toBe(true);
    expect(S.pageHasSensitiveFields(page('<input aria-label="Credit card number">'))).toBe(true);
  });

  it('leaves ordinary pages alone', () => {
    expect(S.pageHasSensitiveFields(page('<p>The credit card number on your statement.</p><input type="search" name="q">'))).toBe(false);
    expect(S.pageHasSensitiveFields(page('<input type="text" name="email"><input type="checkbox" name="card-number">'))).toBe(false);
    expect(S.pageHasSensitiveFields(page('<article><p>Hello</p></article>'))).toBe(false);
  });

  it('never throws on a bad document', () => {
    expect(S.pageHasSensitiveFields(null)).toBe(false);
    expect(S.pageHasSensitiveFields({})).toBe(false);
  });
});

describe('exclusion patterns', () => {
  it('turns the lists into match patterns for the registered script', () => {
    const p = S.excludeMatchPatterns(['myemployer.com']);
    expect(p).toContain('*://*.mail.google.com/*');
    expect(p).toContain('*://*.paypal.com/*');
    expect(p).toContain('*://*.myemployer.com/*');
    expect(new Set(p).size).toBe(p.length);
  });
});

describe('the run gate', () => {
  function setup({ host = 'en.wikipedia.org', html = '<p>hi</p>', enabled = true, mine = [] } = {}) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    const doc = dom.window.document;
    let booted = false;
    const log = [];
    let observer = null;
    class FakeMO { constructor(cb) { observer = cb; } observe() {} }
    const timers = [];
    const gate = S.createRunGate({
      boot: () => { booted = true; log.push('boot'); },
      teardown: () => { booted = false; log.push('teardown'); },
      isBooted: () => booted,
      hostname: () => host,
      doc,
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      MutationObserverImpl: FakeMO,
    });
    gate.watch();
    gate.init(enabled, mine);
    return { gate, doc, log, fire: () => { observer(); timers.splice(0).forEach((f) => f()); }, isBooted: () => booted };
  }

  it('runs on an ordinary page', () => {
    const t = setup();
    expect(t.log).toEqual(['boot']);
  });

  it('never starts on a sensitive host, and says why', () => {
    const t = setup({ host: 'mail.google.com' });
    expect(t.log).toEqual([]);
    expect(t.gate.isSensitive()).toBe(true);
  });

  it('never starts on a page with a password field', () => {
    const t = setup({ html: '<input type="password">' });
    expect(t.log).toEqual([]);
  });

  it('never starts on a host in the reader\'s own list', () => {
    expect(setup({ host: 'hr.myemployer.com', mine: ['myemployer.com'] }).log).toEqual([]);
  });

  it('stays off while the master switch is off, and starts when it comes on', () => {
    const t = setup({ enabled: false });
    expect(t.log).toEqual([]);
    t.gate.setEnabled(true);
    expect(t.log).toEqual(['boot']);
  });

  it('stops when a sign-in form appears later, and starts again when it goes', () => {
    const t = setup();
    expect(t.isBooted()).toBe(true);
    t.doc.body.insertAdjacentHTML('beforeend', '<form><input type="password"></form>');
    t.fire();
    expect(t.log).toEqual(['boot', 'teardown']);
    t.doc.querySelector('form').remove();
    t.fire();
    expect(t.log).toEqual(['boot', 'teardown', 'boot']);
  });

  it('stops when the reader adds the current site to their list', () => {
    const t = setup({ host: 'blog.example.com' });
    t.gate.setUserSites(['example.com']);
    expect(t.log).toEqual(['boot', 'teardown']);
  });

  it('checks again at most once per burst of page changes', () => {
    const dom = new JSDOM('<!doctype html><body><p>x</p></body>');
    const timers = [];
    let cb = null;
    class FakeMO { constructor(f) { cb = f; } observe() {} }
    const gate = S.createRunGate({
      boot() {}, teardown() {}, isBooted: () => true, hostname: () => 'a.org', doc: dom.window.document,
      setTimer: (fn) => { timers.push(fn); return 1; }, MutationObserverImpl: FakeMO,
    });
    gate.watch();
    cb(); cb(); cb();
    expect(timers.length).toBe(1);
  });

  it('treats a failing check as sensitive', () => {
    const gate = S.createRunGate({
      boot() {}, teardown() {}, isBooted: () => false, hostname: () => { throw new Error('x'); }, doc: null,
    });
    expect(gate.isSensitive()).toBe(true);
  });
});
