/* popup.js — the toolbar panel.
 *
 * Two things to know before editing:
 *
 * 1. State vocabulary. The engine emits on_pace / skimming / struggling /
 *    drifting / absent / unknown. This panel used to display the older
 *    focused / confused / zoning_out / overloaded names, so the chips never
 *    lit up — nothing ever sent a label that matched an element id. STATE_UI
 *    below is the single place the names, their wording and their dot colour
 *    are defined, and LEGACY_STATES maps the old names onto the new ones for
 *    anything still speaking the old vocabulary.
 *
 * 2. The camera is off unless the reader turns it on. `sra_eye` defaults to
 *    false here, in content.js and in the service worker's guard. Reading
 *    modes deliberately do not set it: switching to "Study" must never start
 *    a webcam.
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

/* Safari on iOS and iPadOS does not give a web extension a working camera,
 * and `navigator.mediaDevices` still exists there, so feature-detection alone
 * reports a capability that is not real. The platform check is the honest
 * one. When it fails, every camera control leaves the panel rather than
 * sitting there doing nothing — detection is telemetry-first regardless, so
 * nothing else about the product changes on those devices. */
function cameraIsAvailable() {
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  if (iOS) return false;
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const CAMERA_AVAILABLE = cameraIsAvailable();
  document.body.classList.toggle('no-camera', !CAMERA_AVAILABLE);

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
  const eyeToggle           = $('eyeToggle');
  const selToggle           = $('selToggle');
  const highlightToggle     = $('highlightToggle');
  const autohideToggle      = $('autohideToggle');
  const autohideTimeout     = $('autohideTimeout');
  const timeoutRow          = $('timeoutRow');
  const pinDefaultToggle    = $('pinDefaultToggle');
  const debugTogglePopup    = $('debugTogglePopup');
  const idleBlinkToggle     = $('idleBlinkToggle');
  const comprehensionToggle = $('comprehensionToggle');
  const ttsToggle           = $('ttsToggle');
  const focusRulerToggle    = $('focusRulerToggle');
  const dyslexiaToggle      = $('dyslexiaToggle');
  const dyslexiaOptions     = $('dyslexiaOptions');
  const bionicToggle        = $('bionicToggle');
  const dyslexiaColorSelect = $('dyslexiaColorSelect');
  const backendUrlInput     = $('backendUrl');
  const darkModeToggle      = $('darkModeToggle');

  const stateDot     = $('stateDot');
  const stateName    = $('stateName');
  const stateWhy     = $('stateWhy');
  const signalChip   = $('signalChip');
  const signalStatus = $('signalStatus');
  const cameraChip   = $('cameraChip');
  const cameraStatus = $('cameraStatus');

  // ── Settings ────────────────────────────────────────────────────────────
  // sra_eye is false by default. A reading assistant that asks for the webcam
  // on first run is a reading assistant nobody installs twice.
  const DEFAULTS = {
    sra_backend_url: 'http://localhost:3000/api/summarize',
    sra_eye: false, sra_selection: true, sra_highlight_para: true,
    sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_enabled: true,
    sra_idle_blink: true, sra_comprehension: true,
    sra_camera_ready: false, sra_camera_error: '', sra_current_state: '',
    sra_tts: false, sra_focus_ruler: false,
    sra_dyslexia: false, sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
    sra_dark_mode: false, sra_active_persona: '',
  };

  chrome.storage.local.get(DEFAULTS, (res) => {
    backendUrlInput.value       = res.sra_backend_url;
    eyeToggle.checked           = CAMERA_AVAILABLE && !!res.sra_eye;
    if (!CAMERA_AVAILABLE && res.sra_eye) chrome.storage.local.set({ sra_eye: false });
    selToggle.checked           = res.sra_selection !== false;
    highlightToggle.checked     = res.sra_highlight_para !== false;
    autohideToggle.checked      = !!res.sra_autohide;
    autohideTimeout.value       = res.sra_autohide_timeout;
    timeoutRow.style.display    = res.sra_autohide ? 'flex' : 'none';
    pinDefaultToggle.checked    = !!res.sra_pin_default;
    debugTogglePopup.checked    = !!res.sra_debug;
    idleBlinkToggle.checked     = res.sra_idle_blink !== false;
    comprehensionToggle.checked = res.sra_comprehension !== false;
    assistantToggle.checked     = res.sra_enabled !== false;
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

    if (res.sra_camera_ready)      setCameraStatus('on',    'Camera on');
    else if (res.sra_camera_error) setCameraStatus('error', 'Camera error');
    else                           setCameraStatus('',      'Camera off');

    setSignalChip(res.sra_comprehension !== false);
    if (res.sra_current_state) setReadingState(res.sra_current_state);
  });

  // ── Status ──────────────────────────────────────────────────────────────
  function setCameraStatus(kind, text) {
    cameraChip.className = 'src-chip' + (kind ? ' ' + kind : '');
    cameraStatus.textContent = text;
  }

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
        if (resp?.cameraReady) setCameraStatus('on', 'Camera on');
      });
    });
  }, 2500);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sra_camera_ready?.newValue === true) setCameraStatus('on', 'Camera on');
    if (changes.sra_camera_error?.newValue)          setCameraStatus('error', 'Camera error');
    if (changes.sra_current_state?.newValue)         setReadingState(changes.sra_current_state.newValue);
  });

  // ── Save & broadcast ────────────────────────────────────────────────────
  function saveAndBroadcast() {
    const s = {
      sra_backend_url:      backendUrlInput.value.trim(),
      sra_eye:              eyeToggle.checked,
      sra_selection:        selToggle.checked,
      sra_highlight_para:   highlightToggle.checked,
      sra_autohide:         autohideToggle.checked,
      sra_autohide_timeout: Number(autohideTimeout.value) || 12,
      sra_pin_default:      pinDefaultToggle.checked,
      sra_debug:            debugTogglePopup.checked,
      sra_enabled:          assistantToggle.checked,
      sra_idle_blink:       idleBlinkToggle.checked,
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
        eye: s.sra_eye, selection: s.sra_selection,
        highlightPara: s.sra_highlight_para,
        autohide: s.sra_autohide, autohideTimeout: s.sra_autohide_timeout,
        pinDefault: s.sra_pin_default, debug: s.sra_debug,
        idleBlink: s.sra_idle_blink, comprehension: s.sra_comprehension,
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
  assistantToggle.addEventListener('change', () => {
    chrome.storage.local.set({ sra_enabled: assistantToggle.checked });
  });
  autohideToggle.addEventListener('change', () => {
    timeoutRow.style.display = autohideToggle.checked ? 'flex' : 'none';
    saveAndBroadcast();
  });
  dyslexiaToggle.addEventListener('change', () => {
    dyslexiaOptions.style.display = dyslexiaToggle.checked ? 'block' : 'none';
    saveAndBroadcast();
  });
  eyeToggle.addEventListener('change', () => {
    if (eyeToggle.checked) {
      setCameraStatus('loading', 'Starting…');
      sendToTab({ type: 'startCamera' }, () => {});
    } else {
      setCameraStatus('', 'Camera off');
    }
    saveAndBroadcast();
  });

  [selToggle, highlightToggle, pinDefaultToggle, debugTogglePopup,
   idleBlinkToggle, comprehensionToggle, ttsToggle, focusRulerToggle,
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

  // ── Camera ──────────────────────────────────────────────────────────────
  const startCameraBtn = $('startCameraBtn');
  startCameraBtn.addEventListener('click', () => {
    startCameraBtn.disabled = true;
    startCameraBtn.textContent = 'Starting…';
    setCameraStatus('loading', 'Requesting…');
    eyeToggle.checked = true;
    chrome.storage.local.set({ sra_eye: true });
    sendToTab({ type: 'startCamera' }, (resp, err) => {
      startCameraBtn.disabled = false;
      startCameraBtn.textContent = 'Turn the camera on';
      if (err) setCameraStatus('error', 'Reload the page');
    });
  });

  const readingCalBtn = $('readingCalBtn');
  readingCalBtn.addEventListener('click', () => {
    readingCalBtn.disabled = true;
    readingCalBtn.textContent = 'Measuring…';
    chrome.storage.local.set({ sra_ever_calibrated: false });
    sendToTab({ type: 'startReadingCalibration' }, (resp, err) => {
      readingCalBtn.disabled = false;
      readingCalBtn.textContent = 'Measure my reading speed';
      if (err) return;
      window.close();
    });
  });

  const calibrateBtn = $('calibrateBtn');
  calibrateBtn.addEventListener('click', async () => {
    chrome.storage.local.set({ sra_ever_calibrated: false });
    calibrateBtn.disabled = true;
    calibrateBtn.textContent = 'Calibrating…';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tryMsg = () => new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'runCalibration' }, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false });
        else resolve({ ok: true, resp });
      });
    });
    let res = await tryMsg();
    if (!res.ok) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/content.js'] });
        await new Promise((r) => setTimeout(r, 350));
        res = await tryMsg();
      } catch (e) { /* page refuses injection — leave the button usable */ }
    }
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Calibrate';
  });

  $('troubleshootBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/content/camera' });
  });

  // ── Reading modes ───────────────────────────────────────────────────────
  /* Deliberately no sra_eye key. A reading mode changes how the extension
   * behaves, never whether the webcam is running — that stays a decision the
   * reader makes explicitly, once, in one place. */
  const MODES = {
    research: { sra_selection: true,  sra_highlight_para: true,  sra_comprehension: true,  sra_focus_ruler: true,  sra_autohide: false, sra_pin_default: true,  sra_idle_blink: true,  sra_tts: false },
    study:    { sra_selection: true,  sra_highlight_para: true,  sra_comprehension: true,  sra_focus_ruler: false, sra_autohide: true,  sra_autohide_timeout: 10, sra_pin_default: false, sra_idle_blink: true,  sra_tts: true },
    casual:   { sra_selection: true,  sra_highlight_para: false, sra_comprehension: false, sra_focus_ruler: false, sra_autohide: true,  sra_autohide_timeout: 6,  sra_pin_default: false, sra_idle_blink: false, sra_tts: false },
    speed:    { sra_selection: false, sra_highlight_para: false, sra_comprehension: false, sra_focus_ruler: true,  sra_autohide: true,  sra_autohide_timeout: 4,  sra_pin_default: false, sra_idle_blink: true,  sra_tts: false },
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
    idleBlinkToggle.checked     = !!p.sra_idle_blink;
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
  const logoImg = document.getElementById('sra-logo-img');
  if (logoImg) logoImg.src = chrome.runtime.getURL('assets/alcoia.png');
} catch (e) { /* not in an extension context */ }
