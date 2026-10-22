/* site-access.js: which sites alcoia runs on.
 *
 * Install-time permissions cover only the alcoia sites. Everything else is opt-in:
 *   - per site: the reader switches on "Use alcoia on this site" in the popup, which asks the browser for
 *     that one host (optional host permission);
 *   - everywhere: one switch in Settings asks for all http and https pages;
 *   - local files: one switch in Settings asks for file:// pages (the browser also needs "Allow access to
 *     file URLs" turned on for the extension).
 * This module turns the permissions the reader has granted into one dynamically registered content script
 * (chrome.scripting.registerContentScripts), and keeps it in step when permissions or the reader's
 * "never here" list change. The alcoia origins are served by the static content script in the manifest.
 *
 * Classic script (no import/export): background.js loads it with importScripts, Firefox lists it in the
 * background scripts, and the popup and settings pages load it with a script tag. Everything it touches is
 * passed in, so tests can drive it.
 */
(function (root) {
  const SCRIPT_ID = 'alcoia-opt-in-sites';
  const CONTENT_FILES = ['src/shared/config.js', 'src/shared/sensitive-sites.js', 'src/content/content.js'];
  const ALL_WEB = ['http://*/*', 'https://*/*'];
  const ALL_URLS_FORMS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);
  const FILE_PATTERN = 'file:///*';
  // Hosts the static manifest content script already covers.
  const ALCOIA_HOSTS = ['alcoia.app', 'workspace.alcoia.app'];
  // alcoia's own status page, API docs and console are infrastructure, not reading material.
  const INFRA_EXCLUDES = ['https://status.alcoia.app/*', 'https://developers.alcoia.app/*', 'https://console.alcoia.app/*'];

  function isAlcoiaHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return ALCOIA_HOSTS.includes(h);
  }

  // The permission pattern for one site. Match patterns ignore the port, and http and https share a grant.
  function originPattern(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return '*://' + u.hostname + '/*';
    } catch (e) { return null; }
  }

  // Read the granted origins into what the script needs.
  function interpretOrigins(origins) {
    const list = Array.isArray(origins) ? origins : [];
    const everywhere = list.some((o) => ALL_URLS_FORMS.has(o));
    const files = list.includes(FILE_PATTERN);
    const sites = [];
    for (const o of list) {
      if (ALL_URLS_FORMS.has(o) || o === FILE_PATTERN) continue;
      const m = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(o);
      if (!m) continue;
      const host = m[2];
      if (host === '*' || isAlcoiaHost(host) || host === 'server.alcoia.app') continue;
      sites.push({ scheme: m[1], host });
    }
    return { everywhere, files, sites };
  }

  // The registration for the granted permissions, or null when nothing needs registering.
  function buildRegistration(origins, sensitiveApi, userSensitive) {
    const { everywhere, files, sites } = interpretOrigins(origins);
    const matches = [];
    if (everywhere) {
      matches.push(...ALL_WEB);
    } else {
      for (const s of sites) {
        if (s.scheme === '*') { matches.push('http://' + s.host + '/*', 'https://' + s.host + '/*'); } else { matches.push(s.scheme + '://' + s.host + '/*'); }
      }
    }
    if (files) matches.push(FILE_PATTERN);
    if (!matches.length) return null;
    const exclude = INFRA_EXCLUDES.concat(sensitiveApi ? sensitiveApi.excludeMatchPatterns(userSensitive) : []);
    const reg = {
      id: SCRIPT_ID,
      js: CONTENT_FILES.slice(),
      matches,
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    };
    reg.excludeMatches = exclude;
    return reg;
  }

  function create({ chromeApi, sensitiveApi, storageKey = 'sra_sensitive_sites' }) {
    const c = chromeApi;

    async function getUserSensitive() {
      return new Promise((resolve) => {
        try {
          c.storage.local.get({ [storageKey]: [] }, (res) => resolve(Array.isArray(res[storageKey]) ? res[storageKey] : []));
        } catch (e) { resolve([]); }
      });
    }

    async function getGrantedOrigins() {
      try {
        const all = await c.permissions.getAll();
        return (all && all.origins) || [];
      } catch (e) { return []; }
    }

    // Register, update or remove the dynamic script so it matches the granted permissions.
    async function sync() {
      if (!c.scripting || !c.scripting.registerContentScripts) return { ok: false, reason: 'no_scripting' };
      const reg = buildRegistration(await getGrantedOrigins(), sensitiveApi, await getUserSensitive());
      let existing = [];
      try { existing = await c.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }); } catch (e) { existing = []; }
      try {
        if (!reg) {
          if (existing.length) await c.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
          return { ok: true, registered: false };
        }
        if (existing.length) await c.scripting.updateContentScripts([reg]);
        else await c.scripting.registerContentScripts([reg]);
        return { ok: true, registered: true, matches: reg.matches };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    }

    // Put alcoia on a tab that is already open, so switching a site on does not need a reload.
    async function injectNow(tabId) {
      if (!c.scripting || !c.scripting.executeScript || tabId == null) return false;
      try {
        await c.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES.slice() });
        return true;
      } catch (e) { return false; }
    }

    async function hasAccessTo(url) {
      const pattern = originPattern(url);
      if (!pattern) return false;
      try {
        const host = new URL(url).hostname;
        if (isAlcoiaHost(host)) return true;
        if (await c.permissions.contains({ origins: [pattern] })) return true;
        return await c.permissions.contains({ origins: ['<all_urls>'] });
      } catch (e) { return false; }
    }

    function listen() {
      try { c.permissions.onAdded.addListener(() => { sync(); }); } catch (e) { /* no event */ }
      try { c.permissions.onRemoved.addListener(() => { sync(); }); } catch (e) { /* no event */ }
      try {
        c.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes[storageKey]) sync();
        });
      } catch (e) { /* no storage */ }
    }

    return { sync, injectNow, hasAccessTo, getGrantedOrigins, listen };
  }

  root.AlcoiaSiteAccess = Object.freeze({
    SCRIPT_ID,
    CONTENT_FILES,
    originPattern,
    interpretOrigins,
    buildRegistration,
    isAlcoiaHost,
    INFRA_EXCLUDES,
    create,
  });
})(typeof self !== 'undefined' ? self : this);
