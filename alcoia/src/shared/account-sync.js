/* account-sync.js — reading settings and the reading-speed baseline follow the signed-in account.
 *
 * When the reader is signed in (sra_session in storage), the closed list of reading settings below is
 * read from and saved to GET/PUT /api/account/settings, and the per-language reading speed the
 * comprehension monitor keeps (sra_baseline_wpm, sra_baseline_wpm_by_lang) is read from and saved to
 * GET/PUT /api/account/reading-baseline. The same account then has the same settings, and starts from
 * the same reading pace, in every browser and in the alcoia workspace (workspace.alcoia.app), which
 * runs this extension's own detection code. Signed out, nothing is sent and local storage is the only
 * copy, exactly as before.
 *
 * What leaves the device: the setting values themselves, and words-per-minute numbers. Never text, a page
 * or a URL. The server stores the baseline only while account-based learning is on (it answers 403
 * otherwise, and this file just stops).
 *
 * Classic script (no import/export): background.js loads it with importScripts (Chrome's service worker
 * is not a module) and manifests/firefox.json lists it before background.js. Everything it touches is
 * injected (storage, fetch, config), so tests drive it directly.
 */
(function (root) {
  // account setting -> extension storage key
  const SETTING_KEYS = Object.freeze({
    enabled: 'sra_enabled',
    show_interventions: 'sra_show_interventions',
    explain_on_highlight: 'sra_explain_on_highlight',
    show_self_report: 'sra_show_self_report',
    show_connections: 'sra_show_connections',
    dyslexia: 'sra_dyslexia',
    dyslexia_color: 'sra_dyslexia_color',
    dark_mode: 'sra_dark_mode',
    autohide: 'sra_autohide',
    autohide_timeout: 'sra_autohide_timeout',
    highlight_color: 'sra_highlight_color',
  });
  const STORAGE_TO_SETTING = Object.fromEntries(Object.entries(SETTING_KEYS).map(([a, b]) => [b, a]));
  const BASELINE_KEYS = ['sra_baseline_wpm', 'sra_baseline_wpm_by_lang'];
  const SNAPSHOT_KEY = 'sra_account_sync_snapshot';
  const COLOR = /^(rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d{1,3})\s*)?\)|#[0-9a-f]{3,8})$/i;

  // Only values the server accepts are sent; anything else stays local.
  function validSetting(key, v) {
    if (key === 'autohide_timeout') return Number.isInteger(v) && v >= 3 && v <= 120;
    if (key === 'dyslexia_color') return typeof v === 'string' && v.length <= 40 && COLOR.test(v);
    return typeof v === 'boolean';
  }
  const wpmOk = (v) => Number.isInteger(v) && v > 30 && v < 900;

  function create(opts) {
    const storage = opts.storage;
    const fetchImpl = opts.fetchImpl;
    const backendOrigin = opts.backendOrigin;
    const sessionKey = opts.sessionKey || 'sra_session';
    const now = opts.now || (() => Date.now());
    const pushDelayMs = opts.pushDelayMs ?? 2000;
    const baselineDelayMs = opts.baselineDelayMs ?? 10000;
    const minPullGapMs = opts.minPullGapMs ?? 5 * 60 * 1000;
    const setTimer = opts.setTimeout || setTimeout;
    const clearTimer = opts.clearTimeout || clearTimeout;

    let lastPullAt = 0;
    let pendingSettings = {};
    let settingsTimer = null;
    let baselineTimer = null;
    let baselineAllowed = true; // false after a 403 (learner memory off) until the next pull

    const get = (keys) => new Promise((resolve) => storage.get(keys, (r) => resolve(r || {})));
    const set = (obj) => new Promise((resolve) => storage.set(obj, () => resolve()));

    async function sessionToken() {
      const r = await get(sessionKey);
      const s = r[sessionKey];
      if (!s || typeof s.token !== 'string' || !s.token) return null;
      if (typeof s.expiresAt === 'number' && s.expiresAt <= now()) return null;
      return s.token;
    }

    async function call(method, path, token, body) {
      try {
        const resp = await fetchImpl(backendOrigin + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const data = await resp.json().catch(() => null);
        return { ok: !!resp.ok, status: resp.status, data };
      } catch (e) {
        return { ok: false, status: 0, data: null };
      }
    }

    async function snapshot() { return (await get(SNAPSHOT_KEY))[SNAPSHOT_KEY] || {}; }

    /* Reads the account's settings and baseline into local storage. A first sign-in on an account that never
     * saved settings sends this device's current settings instead, so nothing the reader chose is lost. */
    async function pull({ force = false } = {}) {
      if (!force && now() - lastPullAt < minPullGapMs) return { pulled: false, reason: 'recent' };
      const token = await sessionToken();
      if (!token) return { pulled: false, reason: 'signed_out' };
      lastPullAt = now();
      baselineAllowed = true;

      const local = await get(Object.values(SETTING_KEYS).concat(BASELINE_KEYS));
      const snap = await snapshot();
      const res = await call('GET', '/api/account/settings', token);
      if (res.ok && res.data && res.data.settings) {
        if (!res.data.updatedAt) {
          const seed = {};
          for (const [k, sk] of Object.entries(SETTING_KEYS)) if (sk in local && validSetting(k, local[sk])) seed[k] = local[sk];
          if (Object.keys(seed).length) await call('PUT', '/api/account/settings', token, seed);
          for (const [k, sk] of Object.entries(SETTING_KEYS)) snap[sk] = sk in local ? local[sk] : res.data.settings[k];
        } else {
          const write = {};
          for (const [k, sk] of Object.entries(SETTING_KEYS)) {
            const v = res.data.settings[k];
            if (v === undefined) continue;
            snap[sk] = v;
            if (local[sk] !== v) write[sk] = v;
          }
          // the snapshot goes first so the change listener sees these as the account's own values, not edits
          await set({ [SNAPSHOT_KEY]: snap });
          if (Object.keys(write).length) await set(write);
        }
      }

      const b = await call('GET', '/api/account/reading-baseline', token);
      if (b.ok && b.data && b.data.status === 'enabled') {
        const byLang = Object.assign({}, local.sra_baseline_wpm_by_lang || {});
        let changed = false;
        for (const [lang, wpm] of Object.entries(b.data.byLanguage || {})) {
          if (!wpmOk(byLang[lang]) && wpmOk(wpm)) { byLang[lang] = wpm; changed = true; }
        }
        const write = {};
        if (changed) write.sra_baseline_wpm_by_lang = byLang;
        if (!wpmOk(local.sra_baseline_wpm) && wpmOk(b.data.globalWpm)) write.sra_baseline_wpm = b.data.globalWpm;
        snap.sra_baseline_wpm = write.sra_baseline_wpm ?? local.sra_baseline_wpm ?? null;
        snap.sra_baseline_wpm_by_lang = byLang;
        await set({ [SNAPSHOT_KEY]: snap });
        if (Object.keys(write).length) await set(write);
        // this device knew languages the account did not: send them up
        const missing = Object.keys(byLang).some((l) => !(l in (b.data.byLanguage || {})));
        if (missing || (wpmOk(local.sra_baseline_wpm) && !wpmOk(b.data.globalWpm))) scheduleBaseline(0);
      } else {
        if (b.status === 200 || b.status === 403) baselineAllowed = false;
        await set({ [SNAPSHOT_KEY]: snap });
      }
      return { pulled: true };
    }

    async function flushSettings() {
      settingsTimer = null;
      const changes = pendingSettings;
      pendingSettings = {};
      if (!Object.keys(changes).length) return;
      const token = await sessionToken();
      if (!token) return;
      const res = await call('PUT', '/api/account/settings', token, changes);
      if (res.ok) {
        const snap = await snapshot();
        for (const [k, v] of Object.entries(changes)) snap[SETTING_KEYS[k]] = v;
        await set({ [SNAPSHOT_KEY]: snap });
      }
    }

    function scheduleBaseline(delay) {
      if (baselineTimer) clearTimer(baselineTimer);
      baselineTimer = setTimer(flushBaseline, delay ?? baselineDelayMs);
    }

    async function flushBaseline() {
      baselineTimer = null;
      if (!baselineAllowed) return;
      const token = await sessionToken();
      if (!token) return;
      const local = await get(BASELINE_KEYS);
      const byLanguage = {};
      for (const [lang, wpm] of Object.entries(local.sra_baseline_wpm_by_lang || {})) {
        if (/^[a-z]{2}$/.test(lang) && wpmOk(wpm)) byLanguage[lang] = wpm;
      }
      const globalWpm = wpmOk(local.sra_baseline_wpm) ? local.sra_baseline_wpm : null;
      if (globalWpm === null && !Object.keys(byLanguage).length) return;
      const res = await call('PUT', '/api/account/reading-baseline', token, { globalWpm, byLanguage });
      if (res.status === 403) baselineAllowed = false;
    }

    /* chrome.storage.onChanged listener body. A change to a setting that differs from what the account last
     * said is sent up (batched); a new sign-in pulls. */
    async function onStorageChanged(changes, area) {
      if (area && area !== 'local') return;
      if (changes[sessionKey] && changes[sessionKey].newValue) { pull({ force: true }); return; }
      const keys = Object.keys(changes).filter((k) => k in STORAGE_TO_SETTING);
      const baselineChanged = BASELINE_KEYS.some((k) => k in changes);
      if (!keys.length && !baselineChanged) return;
      if (!(await sessionToken())) return;
      if (keys.length) {
        const snap = await snapshot();
        for (const sk of keys) {
          const v = changes[sk].newValue;
          const k = STORAGE_TO_SETTING[sk];
          if (v === snap[sk] || !validSetting(k, v)) continue;
          pendingSettings[k] = v;
        }
        if (Object.keys(pendingSettings).length) {
          if (settingsTimer) clearTimer(settingsTimer);
          settingsTimer = setTimer(flushSettings, pushDelayMs);
        }
      }
      if (baselineChanged) {
        const snap = await snapshot();
        const same = BASELINE_KEYS.every((k) => !(k in changes) || JSON.stringify(changes[k].newValue) === JSON.stringify(snap[k]));
        if (!same) scheduleBaseline();
      }
    }

    return { pull, onStorageChanged, flushSettings, flushBaseline };
  }

  root.AlcoiaAccountSync = Object.freeze({ create, SETTING_KEYS });
})(typeof self !== 'undefined' ? self : this);
