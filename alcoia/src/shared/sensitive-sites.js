/* sensitive-sites.js: pages where alcoia never runs.
 *
 * Detection and every feature that sends text to the server stay off on banking, payment, webmail,
 * health-portal and password-manager pages, and on any page that has a password or card-number field.
 * Nothing from such a page is read, timed or sent. The reader can add their own sites in Settings
 * (storage key `sra_sensitive_sites`); the built-in list cannot be turned off.
 *
 * Classic script (no import/export), like config.js: the content script, the background script and the
 * settings page all load it. It touches no storage and no network; callers pass the user's list in.
 *
 * The domain lists are a best effort, not a complete census. They are matched on whole labels (a domain
 * entry matches itself and its subdomains, never a longer name that merely ends in the same letters).
 * The field check is the backstop for everything the lists miss.
 */
(function (root) {
  // Each entry matches the host itself and any subdomain of it.
  const WEBMAIL = [
    'mail.google.com', 'inbox.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'outlook.com', 'hotmail.com', 'mail.yahoo.com', 'mail.aol.com', 'proton.me', 'protonmail.com', 'proton.ch',
    'tuta.com', 'tutanota.com', 'fastmail.com', 'fastmail.fm', 'mail.zoho.com', 'zoho.eu', 'icloud.com',
    'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'web.de', 'mail.yandex.com', 'mail.yandex.ru', 'mail.ru',
    'posteo.de', 'mailbox.org', 'hey.com', 'mail.163.com', 'mail.qq.com', 'webmail.ovh.net', 'mail.ovh.net',
    'laposte.net', 'orange.fr', 'free.fr', 'libero.it', 'virgilio.it', 't-online.de', 'freenet.de',
  ];
  const ACCOUNT_SIGN_IN = [
    'accounts.google.com', 'myaccount.google.com', 'login.microsoftonline.com', 'login.live.com',
    'account.microsoft.com', 'appleid.apple.com', 'id.apple.com', 'idmsa.apple.com',
  ];
  const PAYMENTS = [
    'paypal.com', 'paypal.me', 'stripe.com', 'braintreegateway.com', 'squareup.com', 'square.com', 'wise.com',
    'venmo.com', 'cash.app', 'zellepay.com', 'klarna.com', 'adyen.com', 'checkout.com', 'payoneer.com',
    'revolut.com', 'monzo.com', 'n26.com', 'chime.com', 'plaid.com', 'coinbase.com', 'binance.com',
    'kraken.com', 'robinhood.com', 'creem.io', 'paddle.com', 'gocardless.com', 'worldpay.com', 'sumup.com',
    'mollie.com', 'razorpay.com', 'paytm.com', 'alipay.com', 'pay.google.com', 'wallet.google.com',
  ];
  const BANKS = [
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com',
    'usbank.com', 'pnc.com', 'tdbank.com', 'td.com', 'ally.com', 'discover.com', 'americanexpress.com',
    'synchrony.com', 'navyfederal.org', 'schwab.com', 'fidelity.com', 'vanguard.com', 'etrade.com',
    'tdameritrade.com', 'interactivebrokers.com', 'wealthfront.com', 'betterment.com', 'hsbc.com',
    'hsbc.co.uk', 'barclays.co.uk', 'barclays.com', 'lloydsbank.com', 'natwest.com', 'santander.co.uk',
    'santander.com', 'nationwide.co.uk', 'halifax.co.uk', 'rbc.com', 'rbcroyalbank.com', 'scotiabank.com',
    'bmo.com', 'cibc.com', 'desjardins.com', 'ing.com', 'ing.nl', 'ing.de', 'ing.be', 'ing.com.au',
    'commbank.com.au', 'anz.com', 'westpac.com.au', 'nab.com.au', 'bnpparibas.com', 'bnpparibas.fr',
    'credit-agricole.fr', 'societegenerale.fr', 'lcl.fr', 'boursorama.com', 'deutsche-bank.de',
    'commerzbank.de', 'sparkasse.de', 'postbank.de', 'dkb.de', 'rabobank.nl', 'abnamro.nl', 'bbva.com',
    'bbva.es', 'caixabank.es', 'bancsabadell.com', 'unicredit.it', 'intesasanpaolo.com', 'bancobrasil.com.br',
    'itau.com.br', 'bradesco.com.br', 'creditkarma.com', 'experian.com', 'equifax.com', 'transunion.com',
    'intuit.com', 'quickbooks.com', 'turbotax.com',
  ];
  const HEALTH = [
    'mychart.com', 'mychart.org', 'mychartonline.com', 'followmyhealth.com', 'healthelife.com', 'zocdoc.com',
    'teladoc.com', 'mdlive.com', 'kaiserpermanente.org', 'anthem.com', 'aetna.com', 'cigna.com', 'uhc.com',
    'unitedhealthcare.com', 'humana.com', 'bcbs.com', 'medicare.gov', 'myhealth.va.gov', 'app.nhs.uk',
    'access.nhs.uk', 'doctolib.fr', 'doctolib.de', 'doctolib.it', 'ameli.fr', 'patientaccess.com',
    'myhealthrecord.com', 'athenahealth.com', 'labcorp.com', 'questdiagnostics.com',
  ];
  const PASSWORD_MANAGERS = [
    '1password.com', '1password.eu', '1password.ca', 'bitwarden.com', 'bitwarden.eu', 'lastpass.com',
    'dashlane.com', 'keepersecurity.com', 'nordpass.com', 'roboform.com', 'enpass.io', 'passwordboss.com',
    'keepass.info', 'psono.com', 'passbolt.com',
  ];

  const BUILTIN_DOMAINS = Object.freeze(
    [].concat(WEBMAIL, ACCOUNT_SIGN_IN, PAYMENTS, BANKS, HEALTH, PASSWORD_MANAGERS),
  );

  // Subdomain label that names the kind of site (webmail.example.org, onlinebanking.example.com).
  const SENSITIVE_FIRST_LABEL = /^(web)?mail\d*$|^(owa|email|e-?mail)$|^(online|net|e|i|mobile|internet|secure)-?banking$|^patient(portal)?$|^mychart$/i;

  const CARD_AUTOCOMPLETE = /(^|\s)cc-(number|csc|exp|exp-month|exp-year|name|type)(\s|$)/i;
  const CARD_NAME = /card[\s_.\-]?(number|num|no\b)|cc[\s_.\-]?(num|number)|credit[\s_.\-]?card|debit[\s_.\-]?card|\bcvv\b|\bcvc\b|security[\s_.\-]?code|card[\s_.\-]?verification/i;
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);

  function normalizeHost(h) {
    return String(h || '').trim().toLowerCase().replace(/\.+$/, '');
  }

  // Accepts "example.com", "www.example.com", "https://example.com/path", "*.example.com". Returns a bare
  // hostname, or null if nothing usable is there.
  function normalizeUserEntry(input) {
    let s = String(input || '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.split(/[/?#]/)[0];
    s = s.replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '');
    s = s.replace(/\.+$/, '');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) && s !== 'localhost') return null;
    return s;
  }

  function hostMatchesDomain(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  function matchesList(host, list) {
    for (const d of list) if (hostMatchesDomain(host, d)) return true;
    return false;
  }

  function isBuiltInSensitiveHost(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return false;
    if (matchesList(host, BUILTIN_DOMAINS)) return true;
    const labels = host.split('.');
    // Only a subdomain label counts (webmail.school.edu), never the registrable name itself.
    return labels.length >= 3 && SENSITIVE_FIRST_LABEL.test(labels[0]);
  }

  function userDomains(extra) {
    const out = [];
    for (const e of Array.isArray(extra) ? extra : []) {
      const n = normalizeUserEntry(e);
      if (n) out.push(n);
    }
    return out;
  }

  // True for a built-in site or one the reader added.
  function isSensitiveHost(hostname, extra) {
    const host = normalizeHost(hostname);
    if (!host) return false;
    if (isBuiltInSensitiveHost(host)) return true;
    return matchesList(host, userDomains(extra));
  }

  function isSensitiveUrl(url, extra) {
    try { return isSensitiveHost(new URL(url).hostname, extra); } catch (e) { return false; }
  }

  function isCardField(el) {
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (SKIP_TYPES.has(type)) return false;
    if (CARD_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return true;
    const probe = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-testid')]
      .filter(Boolean).join(' ');
    return !!probe && CARD_NAME.test(probe);
  }

  // True when the document has a password field or a card-number style field. Present is enough, visible or
  // not: a hidden login form is still a login page.
  function pageHasSensitiveFields(doc) {
    try {
      const d = doc || (typeof document !== 'undefined' ? document : null);
      if (!d) return false;
      if (d.querySelector('input[type="password" i]')) return true;
      const inputs = d.querySelectorAll('input');
      const limit = Math.min(inputs.length, 400);
      for (let i = 0; i < limit; i++) if (isCardField(inputs[i])) return true;
    } catch (e) { /* never block the page on a scan error */ }
    return false;
  }

  // Match patterns for chrome.scripting.registerContentScripts({ excludeMatches }).
  function excludeMatchPatterns(extra) {
    const set = new Set();
    for (const d of BUILTIN_DOMAINS.concat(userDomains(extra))) set.add('*://*.' + d + '/*');
    return Array.from(set);
  }

  // Decides whether the page script should be running, and keeps deciding as things change: the master
  // switch, the reader's own list, and forms that appear or disappear after load. The page script passes in
  // how to start and stop itself; this owns only the decision. One re-check per second at most.
  function createRunGate({ boot, teardown, isBooted, hostname, doc, setTimer, MutationObserverImpl }) {
    const setT = setTimer || ((fn, ms) => setTimeout(fn, ms));
    const MO = MutationObserverImpl || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    let enabled = true;
    let mine = [];
    let pending = null;

    function isSensitive() {
      try { return isSensitiveHost(hostname(), mine) || pageHasSensitiveFields(doc); } catch (e) { return true; }
    }
    function evaluate() {
      const sensitive = isSensitive();
      const run = enabled && !sensitive;
      if (run) { if (!isBooted()) boot(); } else if (isBooted()) { teardown(); }
      return { run, sensitive };
    }
    function watch() {
      if (!MO || !doc || !doc.documentElement) return;
      try {
        new MO(() => {
          if (pending) return;
          pending = setT(() => { pending = null; evaluate(); }, 1000);
        }).observe(doc.documentElement, { childList: true, subtree: true });
      } catch (e) { /* no observer here */ }
    }
    return {
      evaluate,
      watch,
      isSensitive,
      setEnabled(v) { enabled = v !== false; return evaluate(); },
      setUserSites(list) { mine = Array.isArray(list) ? list : []; return evaluate(); },
      init(isEnabled, list) { enabled = isEnabled !== false; mine = Array.isArray(list) ? list : []; return evaluate(); },
    };
  }

  root.AlcoiaSensitiveSites = Object.freeze({
    createRunGate,
    STORAGE_KEY: 'sra_sensitive_sites',
    BUILTIN_DOMAINS,
    normalizeUserEntry,
    isBuiltInSensitiveHost,
    isSensitiveHost,
    isSensitiveUrl,
    pageHasSensitiveFields,
    excludeMatchPatterns,
  });
})(typeof self !== 'undefined' ? self : this);
