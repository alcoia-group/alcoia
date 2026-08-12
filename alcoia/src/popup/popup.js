/* popup.js — the toolbar panel.
 *
 * State vocabulary. The engine emits on_pace / skimming / struggling /
 * drifting / absent / unknown. This panel used to display the older
 * focused / confused / zoning_out / overloaded names, so the chips never
 * lit up — nothing ever sent a label that matched an element id. STATE_UI
 * below is the single place the names, their wording and their dot colour
 * are defined, and LEGACY_STATES maps the old names onto the new ones for
 * anything still speaking the old vocabulary.
 */

const STATE_UI = {
  on_pace:    { name: 'On pace',      dot: 'live', why: 'Your pace matches the difficulty of this text.' },
  skimming:   { name: 'Skimming',     dot: 'live', why: 'Moving faster than this text usually takes to read.' },
  struggling: { name: 'Struggling',   dot: 'attn', why: 'Slower than your usual pace here, or going back over it.' },
  drifting:   { name: 'Drifting',     dot: 'attn', why: 'Movement on the page has stalled without you leaving it.' },
  absent:     { name: 'Away',         dot: '',     why: 'Nothing to read from — you are away from the page.' },
  unknown:    { name: 'Not sure yet', dot: '',     why: 'The signals do not agree. Nothing interrupts you on this.' },
};

/* Older labels that may still arrive from the simulate path or a stale
 * storage value. Kept as a translation layer, not as a vocabulary. */
const LEGACY_STATES = {
  focused: 'on_pace', confused: 'struggling', overloaded: 'struggling',
  zoning_out: 'drifting', skimming: 'skimming',
};

const canonicalState = (s) => (STATE_UI[s] ? s : LEGACY_STATES[s] || null);

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  // ── Tabs ────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + target));
    });
  });

  // ── Elements ────────────────────────────────────────────────────────────
  const assistantToggle     = $('assistantToggle');
  const selToggle           = $('selToggle');
  const highlightToggle     = $('highlightToggle');
  const autohideToggle      = $('autohideToggle');
  const autohideTimeout     = $('autohideTimeout');
  const timeoutRow          = $('timeoutRow');
  const pinDefaultToggle    = $('pinDefaultToggle');
  const debugTogglePopup    = $('debugTogglePopup');
  const comprehensionToggle = $('comprehensionToggle');
  const ttsToggle           = $('ttsToggle');
  const focusRulerToggle    = $('focusRulerToggle');
  const dyslexiaToggle      = $('dyslexiaToggle');
  const dyslexiaOptions     = $('dyslexiaOptions');
  const bionicToggle        = $('bionicToggle');
  const dyslexiaColorSelect = $('dyslexiaColorSelect');
  const backendUrlInput     = $('backendUrl');
  // The static HTML placeholder would drift from the real default the
  // moment either changed independently — set it from the same config.
  backendUrlInput.placeholder = self.ALCOIA_CONFIG.SUMMARIZE_URL;
  const darkModeToggle      = $('darkModeToggle');

  const stateDot     = $('stateDot');
  const stateName    = $('stateName');
  const stateWhy     = $('stateWhy');
  const signalChip   = $('signalChip');
  const signalStatus = $('signalStatus');

  // ── Settings ────────────────────────────────────────────────────────────
  const DEFAULTS = {
    // Defined in src/shared/config.js, loaded before this file — see
    // popup.html. One place for the shipped origin; overriding this field
    // (below, in the Settings panel) is the documented way to point a dev
    // build at a local backend without editing source or the manifest.
    sra_backend_url: self.ALCOIA_CONFIG.SUMMARIZE_URL,
    sra_selection: true, sra_highlight_para: true,
    sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_enabled: true,
    sra_comprehension: true, sra_current_state: '',
    sra_tts: false, sra_focus_ruler: false,
    sra_dyslexia: false, sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
    sra_dark_mode: false, sra_active_persona: '',
  };

  chrome.storage.local.get(DEFAULTS, (res) => {
    backendUrlInput.value       = res.sra_backend_url;
    selToggle.checked           = res.sra_selection !== false;
    highlightToggle.checked     = res.sra_highlight_para !== false;
    autohideToggle.checked      = !!res.sra_autohide;
    autohideTimeout.value       = res.sra_autohide_timeout;
    timeoutRow.style.display    = res.sra_autohide ? 'flex' : 'none';
    pinDefaultToggle.checked    = !!res.sra_pin_default;
    debugTogglePopup.checked    = !!res.sra_debug;
    comprehensionToggle.checked = res.sra_comprehension !== false;
    assistantToggle.checked     = res.sra_enabled !== false;
    document.body.classList.toggle('assistant-off', res.sra_enabled === false);
    ttsToggle.checked           = !!res.sra_tts;
    focusRulerToggle.checked    = !!res.sra_focus_ruler;
    dyslexiaToggle.checked      = !!res.sra_dyslexia;
    dyslexiaOptions.style.display = res.sra_dyslexia ? 'block' : 'none';
    bionicToggle.checked        = !!res.sra_bionic;
    dyslexiaColorSelect.value   = res.sra_dyslexia_color || '';

    darkModeToggle.checked = !!res.sra_dark_mode;
    document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);

    if (res.sra_active_persona) {
      document.querySelectorAll('.mode-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.persona === res.sra_active_persona));
    }

    setSignalChip(res.sra_comprehension !== false);
    if (res.sra_current_state) setReadingState(res.sra_current_state);
  });

  // ── Status ──────────────────────────────────────────────────────────────
  function setSignalChip(on) {
    signalChip.className = 'src-chip' + (on ? ' on' : '');
    signalStatus.textContent = on ? 'Reading signals' : 'Reading signals off';
  }

  /* Paint the fused estimate. An unrecognised label is shown as unknown
   * rather than guessed at — inventing a state here would be the UI telling
   * the reader something the engine never said. */
  function setReadingState(raw) {
    const key = canonicalState(raw);
    const ui  = STATE_UI[key] || STATE_UI.unknown;

    stateName.textContent = ui.name;
    stateWhy.textContent  = ui.why;
    stateDot.className    = 'state-dot' + (ui.dot ? ' ' + ui.dot : '');

    Object.keys(STATE_UI).forEach((s) => {
      const el = $('chip-' + s);
      if (!el) return;
      el.className = 'chip' + (s === key ? ' on on-' + s : '');
    });
  }

  // ── Live state while the panel is open ──────────────────────────────────
  setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'getState' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp?.state) setReadingState(resp.state);
      });
    });
  }, 2500);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sra_current_state?.newValue) setReadingState(changes.sra_current_state.newValue);
  });

  // ── Save & broadcast ────────────────────────────────────────────────────
  function saveAndBroadcast() {
    const s = {
      sra_backend_url:      backendUrlInput.value.trim(),
      sra_selection:        selToggle.checked,
      sra_highlight_para:   highlightToggle.checked,
      sra_autohide:         autohideToggle.checked,
      sra_autohide_timeout: Number(autohideTimeout.value) || 12,
      sra_pin_default:      pinDefaultToggle.checked,
      sra_debug:            debugTogglePopup.checked,
      sra_enabled:          assistantToggle.checked,
      sra_comprehension:    comprehensionToggle.checked,
      sra_tts:              ttsToggle.checked,
      sra_focus_ruler:      focusRulerToggle.checked,
      sra_dyslexia:         dyslexiaToggle.checked,
      sra_dyslexia_color:   dyslexiaColorSelect.value,
      sra_bionic:           bionicToggle.checked,
      sra_dark_mode:        darkModeToggle.checked,
    };
    chrome.storage.local.set(s);
    document.body.classList.toggle('dark-mode', s.sra_dark_mode);
    setSignalChip(s.sra_comprehension);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'settings',
        backendUrl: s.sra_backend_url,
        selection: s.sra_selection,
        highlightPara: s.sra_highlight_para,
        autohide: s.sra_autohide, autohideTimeout: s.sra_autohide_timeout,
        pinDefault: s.sra_pin_default, debug: s.sra_debug,
        comprehension: s.sra_comprehension,
        tts: s.sra_tts, focusRuler: s.sra_focus_ruler,
        dyslexia: s.sra_dyslexia, dyslexiaColor: s.sra_dyslexia_color,
        bionic: s.sra_bionic,
        darkMode: s.sra_dark_mode,
      }, () => { if (chrome.runtime.lastError) { /* no content script here */ } });
      chrome.tabs.sendMessage(tabs[0].id, { type: 'debugToggle', enabled: s.sra_debug },
        () => { if (chrome.runtime.lastError) { /* no content script here */ } });
    });
  }

  // ── Toggles ─────────────────────────────────────────────────────────────
  /* The master switch. Writing the key is enough — every open tab listens for
   * it via chrome.storage.onChanged, which a settings broadcast to the active
   * tab would miss. */
  assistantToggle.addEventListener('change', () => {
    chrome.storage.local.set({ sra_enabled: assistantToggle.checked });
    document.body.classList.toggle('assistant-off', !assistantToggle.checked);
  });
  autohideToggle.addEventListener('change', () => {
    timeoutRow.style.display = autohideToggle.checked ? 'flex' : 'none';
    saveAndBroadcast();
  });
  dyslexiaToggle.addEventListener('change', () => {
    dyslexiaOptions.style.display = dyslexiaToggle.checked ? 'block' : 'none';
    saveAndBroadcast();
  });
  [selToggle, highlightToggle, pinDefaultToggle, debugTogglePopup,
   comprehensionToggle, ttsToggle, focusRulerToggle,
   bionicToggle, darkModeToggle]
    .forEach((el) => el.addEventListener('change', saveAndBroadcast));
  [backendUrlInput, autohideTimeout, dyslexiaColorSelect]
    .forEach((el) => el.addEventListener('change', saveAndBroadcast));

  // ── Tab messaging ───────────────────────────────────────────────────────
  function sendToTab(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) { cb && cb(null); return; }
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
        if (chrome.runtime.lastError) { cb && cb(null, chrome.runtime.lastError); return; }
        cb && cb(resp);
      });
    });
  }

  /* Buttons that just poke the content script and close. `busy` label is
   * restored on failure so a page without a content script does not leave a
   * button stuck saying "Opening…". */
  function wireTabAction(id, msg, busyLabel) {
    const btn = $(id);
    if (!btn) return;
    const idle = btn.textContent;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      if (busyLabel) btn.textContent = busyLabel;
      sendToTab(msg, (resp, err) => {
        btn.disabled = false;
        btn.textContent = idle;
        if (err) return;
        window.close();
      });
    });
  }

  wireTabAction('pageSummaryBtn', { type: 'pageSummary' },      'Reading the page…');
  wireTabAction('recallBtn',      { action: 'sessionRecall' },  'Opening…');
  wireTabAction('receiptBtn',     { action: 'showReceipt' },    'Opening…');

  // ── Pages ───────────────────────────────────────────────────────────────
  const openPage = (id, path) => $(id)?.addEventListener('click',
    () => chrome.tabs.create({ url: chrome.runtime.getURL(path) }));

  openPage('notesBtn',          'src/popup/notes.html');
  openPage('sessionReportBtn',  'src/popup/session-report.html');
  openPage('viewHighlightsBtn', 'src/popup/highlights.html');
  openPage('exportBtn',         'src/popup/export.html');
  openPage('upgradeBtn',        'src/popup/upgrade.html');
  openPage('diagnosticsBtn',    'src/popup/diagnostics.html');

  // ── Reading speed ──────────────────────────────────────────────────────
  const readingCalBtn = $('readingCalBtn');
  readingCalBtn.addEventListener('click', () => {
    readingCalBtn.disabled = true;
    readingCalBtn.textContent = 'Measuring…';
    sendToTab({ type: 'startReadingCalibration' }, (resp, err) => {
      readingCalBtn.disabled = false;
      readingCalBtn.textContent = 'Measure my reading speed';
      if (err) return;
      window.close();
    });
  });

  /* ── Host access ──────────────────────────────────────────────────────
   * Chrome grants host permissions at install. Firefox MV3 treats them as
   * optional: the extension is installed but cannot read any page until the
   * reader says so. Without this the extension would appear installed and
   * do nothing, with no explanation anywhere. `permissions.request()` has to
   * be called from a user gesture, which is why it lives on a click. */
  const permBanner = $('permBanner');
  const permGrantBtn = $('permGrantBtn');

  function refreshHostPermission() {
    if (!permBanner || !chrome.permissions?.contains) return;
    try {
      chrome.permissions.contains({ origins: ['<all_urls>'] }, (granted) => {
        if (chrome.runtime.lastError) return;
        permBanner.hidden = !!granted;
        document.body.classList.toggle('no-host-access', !granted);
      });
    } catch (e) { /* API absent — assume granted, as on Chrome */ }
  }

  permGrantBtn?.addEventListener('click', () => {
    chrome.permissions.request({ origins: ['<all_urls>'] }, () => {
      if (chrome.runtime.lastError) return;
      refreshHostPermission();
    });
  });

  refreshHostPermission();

  // ── Reading modes ───────────────────────────────────────────────────────
  const MODES = {
    research: { sra_selection: true,  sra_highlight_para: true,  sra_comprehension: true,  sra_focus_ruler: true,  sra_autohide: false, sra_pin_default: true,  sra_tts: false },
    study:    { sra_selection: true,  sra_highlight_para: true,  sra_comprehension: true,  sra_focus_ruler: false, sra_autohide: true,  sra_autohide_timeout: 10, sra_pin_default: false, sra_tts: true },
    casual:   { sra_selection: true,  sra_highlight_para: false, sra_comprehension: false, sra_focus_ruler: false, sra_autohide: true,  sra_autohide_timeout: 6,  sra_pin_default: false, sra_tts: false },
    speed:    { sra_selection: false, sra_highlight_para: false, sra_comprehension: false, sra_focus_ruler: true,  sra_autohide: true,  sra_autohide_timeout: 4,  sra_pin_default: false, sra_tts: false },
  };

  function applyMode(key) {
    const p = MODES[key];
    if (!p) return;
    chrome.storage.local.set({ ...p, sra_active_persona: key });

    selToggle.checked           = !!p.sra_selection;
    highlightToggle.checked     = !!p.sra_highlight_para;
    comprehensionToggle.checked = !!p.sra_comprehension;
    focusRulerToggle.checked    = !!p.sra_focus_ruler;
    autohideToggle.checked      = !!p.sra_autohide;
    pinDefaultToggle.checked    = !!p.sra_pin_default;
    ttsToggle.checked           = !!p.sra_tts;
    if (p.sra_autohide_timeout) autohideTimeout.value = p.sra_autohide_timeout;
    timeoutRow.style.display = p.sra_autohide ? 'flex' : 'none';

    document.querySelectorAll('.mode-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.persona === key));

    saveAndBroadcast();
  }

  document.querySelectorAll('.mode-btn').forEach((btn) =>
    btn.addEventListener('click', () => applyMode(btn.dataset.persona)));

  // ── Simulate ────────────────────────────────────────────────────────────
  function simulateState(state) {
    sendToTab({ type: 'simulateState', state }, (resp, err) => {
      if (err) alert('No content script on this page. Open a page with text first.');
    });
  }

  $('simStrugglingBtn').addEventListener('click', () => simulateState('struggling'));
  $('simDriftingBtn')  .addEventListener('click', () => simulateState('drifting'));
  $('simSkimmingBtn')  .addEventListener('click', () => simulateState('skimming'));
  $('simOnPaceBtn')    .addEventListener('click', () => simulateState('on_pace'));
});

// ── Logo (packaged path differs from the relative one in the markup) ───────
try {
  const logo = document.getElementById('sra-logo-img');
  const logoDark = document.getElementById('sra-logo-img-dark');
  if (logo) logo.src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
  if (logoDark) logoDark.src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
  const cj = document.getElementById('cjLogo');
  const cjDark = document.getElementById('cjLogoDark');
  if (cj) cj.src = chrome.runtime.getURL('assets/logo-cj-black.png');
  if (cjDark) cjDark.src = chrome.runtime.getURL('assets/logo-cj-white.png');
} catch (e) { /* not in an extension context */ }
