document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);

  // ── Tab switching ──────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + target));
    });
  });

  // ── Element references ─────────────────────────────────────────────────
  const assistantToggle    = $('assistantToggle');
  const eyeToggle          = $('eyeToggle');
  const selToggle          = $('selToggle');
  const highlightToggle    = $('highlightToggle');
  const autohideToggle     = $('autohideToggle');
  const autohideTimeout    = $('autohideTimeout');
  const timeoutRow         = $('timeoutRow');
  const pinDefaultToggle   = $('pinDefaultToggle');
  const debugTogglePopup   = $('debugTogglePopup');
  const idleBlinkToggle    = $('idleBlinkToggle');
  const comprehensionToggle = $('comprehensionToggle');
  const ttsToggle          = $('ttsToggle');
  const focusRulerToggle   = $('focusRulerToggle');
  const dyslexiaToggle     = $('dyslexiaToggle');
  const dyslexiaOptions    = $('dyslexiaOptions');
  const bionicToggle       = $('bionicToggle');
  const dyslexiaColorSelect = $('dyslexiaColorSelect');
  const backendUrlInput    = $('backendUrl');
  const startCameraBtn     = $('startCameraBtn');
  const calibrateBtn       = $('calibrateBtn');
  const troubleshootBtn    = $('troubleshootBtn');
  const readingCalBtn      = $('readingCalBtn');
  const upgradeBtn         = $('upgradeBtn');
  const notesBtn           = $('notesBtn');
  const sessionReportBtn   = $('sessionReportBtn');
  const viewHighlightsBtn  = $('viewHighlightsBtn');
  const exportBtn          = $('exportBtn');
  const pageSummaryBtn     = $('pageSummaryBtn');
  const cameraDot          = $('cameraDot');
  const cameraStatus       = $('cameraStatus');
  const cogStateChip       = $('cogStateChip');

  // ── Load saved settings ────────────────────────────────────────────────
  const DEFAULTS = {
    sra_backend_url: 'http://localhost:3000/api/summarize',
    sra_eye: true, sra_selection: true, sra_highlight_para: true,
    sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_enabled: true,
    sra_idle_blink: true, sra_comprehension: true,
    sra_camera_ready: false, sra_camera_error: '', sra_current_state: '',
    sra_tts: false, sra_focus_ruler: false,
    sra_dyslexia: false, sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
  };

  chrome.storage.local.get(DEFAULTS, (res) => {
    backendUrlInput.value      = res.sra_backend_url;
    eyeToggle.checked          = res.sra_eye;
    selToggle.checked          = res.sra_selection;
    highlightToggle.checked    = res.sra_highlight_para;
    autohideToggle.checked     = res.sra_autohide;
    autohideTimeout.value      = res.sra_autohide_timeout;
    timeoutRow.style.display   = res.sra_autohide ? 'flex' : 'none';
    pinDefaultToggle.checked   = res.sra_pin_default;
    debugTogglePopup.checked   = res.sra_debug;
    idleBlinkToggle.checked    = res.sra_idle_blink !== false;
    comprehensionToggle.checked = res.sra_comprehension !== false;
    assistantToggle.checked    = res.sra_enabled !== false;
    ttsToggle.checked          = !!res.sra_tts;
    focusRulerToggle.checked   = !!res.sra_focus_ruler;
    dyslexiaToggle.checked     = !!res.sra_dyslexia;
    dyslexiaOptions.style.display = res.sra_dyslexia ? 'block' : 'none';
    bionicToggle.checked       = !!res.sra_bionic;
    dyslexiaColorSelect.value  = res.sra_dyslexia_color || '';

    if (res.sra_camera_ready)       setCameraStatus('active', 'camera active');
    else if (res.sra_camera_error)  setCameraStatus('error',  'camera error — see console');
    else                            setCameraStatus('', 'camera off');

    if (res.sra_current_state) setCogState(res.sra_current_state);
  });

  // ── Status helpers ─────────────────────────────────────────────────────
  function setCameraStatus(state, text) {
    cameraDot.className  = 'status-dot' + (state ? ' ' + state : '');
    cameraStatus.textContent = text;
  }

  function setCogState(label) {
    if (!label) return;
    cogStateChip.textContent = label.replace('_', ' ');
    ['focused','skimming','confused','zoning_out','overloaded'].forEach(s => {
      const el = $('chip-' + s);
      if (el) el.className = 'chip';
    });
    const active = $('chip-' + label);
    if (active) active.className = 'chip active-' + label;
  }

  // ── Poll state from content script while popup is open ─────────────────
  setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'getState' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp?.state)       setCogState(resp.state);
        if (resp?.cameraReady) setCameraStatus('active', 'camera active');
      });
    });
  }, 2500);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sra_camera_ready?.newValue === true)  setCameraStatus('active', 'camera active');
    if (changes.sra_camera_error?.newValue)           setCameraStatus('error',  'camera error — see console');
    if (changes.sra_current_state?.newValue)          setCogState(changes.sra_current_state.newValue);
  });

  // ── Save & broadcast ───────────────────────────────────────────────────
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
    };
    chrome.storage.local.set(s);
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
      }, () => { if (chrome.runtime.lastError) {} });
      chrome.tabs.sendMessage(tabs[0].id, { type: 'debugToggle', enabled: s.sra_debug },
        () => { if (chrome.runtime.lastError) {} });
    });
  }

  // ── Wire toggles ───────────────────────────────────────────────────────
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
      setCameraStatus('loading', 'starting…');
      sendToTab({ type: 'startCamera' }, () => {});
    } else {
      setCameraStatus('', 'camera off');
    }
    saveAndBroadcast();
  });

  [selToggle, highlightToggle, pinDefaultToggle, debugTogglePopup,
   idleBlinkToggle, comprehensionToggle, ttsToggle, focusRulerToggle, bionicToggle]
    .forEach(el => el.addEventListener('change', saveAndBroadcast));
  [backendUrlInput, autohideTimeout, dyslexiaColorSelect]
    .forEach(el => el.addEventListener('change', saveAndBroadcast));

  // ── Button helpers ─────────────────────────────────────────────────────
  function sendToTab(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) { cb && cb(null); return; }
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
        if (chrome.runtime.lastError) { cb && cb(null, chrome.runtime.lastError); return; }
        cb && cb(resp);
      });
    });
  }

  startCameraBtn.addEventListener('click', () => {
    startCameraBtn.disabled = true;
    startCameraBtn.textContent = 'Starting…';
    setCameraStatus('loading', 'requesting camera…');
    sendToTab({ type: 'startCamera' }, (resp, err) => {
      startCameraBtn.disabled = false;
      startCameraBtn.textContent = 'Start Camera';
      if (err) setCameraStatus('error', 'no content script — reload page');
    });
  });

  readingCalBtn.addEventListener('click', async () => {
    readingCalBtn.disabled = true;
    readingCalBtn.textContent = 'Calibrating...';
    chrome.storage.local.set({ sra_ever_calibrated: false });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { type: 'startReadingCalibration' }, (resp) => {
      if (chrome.runtime.lastError) alert('No content script — reload the page and try again.');
      readingCalBtn.disabled = false;
      readingCalBtn.textContent = 'Reading Calibration';
    });
  });

  calibrateBtn.addEventListener('click', async () => {
    chrome.storage.local.set({ sra_ever_calibrated: false });
    calibrateBtn.disabled = true;
    calibrateBtn.textContent = 'Calibrating…';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tryMsg = () => new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: 'runCalibration' }, resp => {
        if (chrome.runtime.lastError) resolve({ ok: false });
        else resolve({ ok: true, resp });
      });
    });
    let res = await tryMsg();
    if (!res.ok) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/content.js'] });
        await new Promise(r => setTimeout(r, 350));
        res = await tryMsg();
      } catch (e) {}
    }
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Dot Calibration';
  });

  troubleshootBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/content/camera' });
  });

  notesBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/notes.html') });
  });

  sessionReportBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/session-report.html') });
  });

  viewHighlightsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/highlights.html') });
  });

  exportBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/export.html') });
  });

  pageSummaryBtn.addEventListener('click', () => {
    pageSummaryBtn.disabled = true;
    pageSummaryBtn.textContent = 'Analysing…';
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]?.id) { pageSummaryBtn.disabled = false; pageSummaryBtn.textContent = 'What is this page? ✦'; return; }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'pageSummary' }, () => {
        pageSummaryBtn.disabled = false;
        pageSummaryBtn.textContent = 'What is this page? ✦';
        window.close();
      });
    });
  });

  upgradeBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/upgrade.html') });
  });

  // ── Simulate state buttons ─────────────────────────────────────────────
  function simulateState(state) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'simulateState', state }, (resp) => {
        if (chrome.runtime.lastError)
          alert('No content script on this page. Navigate to a page with text first.');
      });
    });
  }

  $('testConfusedBtn')   && $('testConfusedBtn').addEventListener('click',   () => simulateState('confused'));
  $('testOverloadedBtn') && $('testOverloadedBtn').addEventListener('click',  () => simulateState('overloaded'));
  $('testZoningBtn')     && $('testZoningBtn').addEventListener('click',     () => simulateState('zoning_out'));
  $('testSkimmingBtn')   && $('testSkimmingBtn').addEventListener('click',   () => simulateState('skimming'));

});

// ── Logo fallback ──────────────────────────────────────────────────────────
try {
  const logoImg = document.getElementById('sra-logo-img');
  if (logoImg) logoImg.src = chrome.runtime.getURL('assets/tldr.png');
} catch (e) {}
