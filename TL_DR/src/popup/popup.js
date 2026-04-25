document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);

  const assistantToggle  = $('assistantToggle');
  const eyeToggle        = $('eyeToggle');
  const selToggle        = $('selToggle');
  const highlightToggle  = $('highlightToggle');
  const autohideToggle   = $('autohideToggle');
  const autohideTimeout  = $('autohideTimeout');
  const timeoutRow       = $('timeoutRow');
  const pinDefaultToggle = $('pinDefaultToggle');
  const debugTogglePopup = $('debugTogglePopup');
  const backendUrlInput  = $('backendUrl');
  const startCameraBtn   = $('startCameraBtn');
  const calibrateBtn     = $('calibrateBtn');
  const troubleshootBtn  = $('troubleshootBtn');
  const upgradeBtn       = $('upgradeBtn');
  const cameraDot        = $('cameraDot');
  const cameraStatus     = $('cameraStatus');
  const cogStateChip     = $('cogStateChip');

  // ── Load saved settings ────────────────────────────────────────────────
  const DEFAULTS = {
    sra_backend_url: 'http://localhost:3000/api/summarize',
    sra_eye: true, sra_selection: true, sra_highlight_para: true,
    sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_enabled: true,
    sra_camera_ready: false, sra_camera_error: '', sra_current_state: '',
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
    if (idleBlinkToggle)     idleBlinkToggle.checked     = res.sra_idle_blink !== false;
    if (comprehensionToggle) comprehensionToggle.checked = res.sra_comprehension !== false;
    assistantToggle.checked    = res.sra_enabled !== false;

    // Restore camera status from storage
    if (res.sra_camera_ready) {
      setCameraStatus('active', 'camera active');
    } else if (res.sra_camera_error) {
      setCameraStatus('error', 'camera error — see console');
    } else {
      setCameraStatus('', 'camera off');
    }

    // Restore cognitive state
    if (res.sra_current_state) setCogState(res.sra_current_state);
  });

  // ── Status helpers ─────────────────────────────────────────────────────
  function setCameraStatus(state, text) {
    cameraDot.className = 'status-dot' + (state ? ' ' + state : '');
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
  const statePoller = setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'getState' }, (resp) => {
        if (chrome.runtime.lastError) {
          // Content script not responding — show error only if we expected it
          return;
        }
        if (resp?.state)        setCogState(resp.state);
        if (resp?.cameraReady)  setCameraStatus('active', 'camera active');
      });
    });
  }, 2500);

  // Also listen for storage changes (camera ready event from content script)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sra_camera_ready?.newValue === true)
      setCameraStatus('active', 'camera active');
    if (changes.sra_camera_error?.newValue)
      setCameraStatus('error', 'camera error — see console');
    if (changes.sra_current_state?.newValue)
      setCogState(changes.sra_current_state.newValue);
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
      sra_idle_blink:       idleBlinkToggle    ? idleBlinkToggle.checked    : true,
      sra_comprehension:    comprehensionToggle ? comprehensionToggle.checked : true,
    };
    chrome.storage.local.set(s);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'settings', backendUrl: s.sra_backend_url,
        eye: s.sra_eye, selection: s.sra_selection,
        highlightPara: s.sra_highlight_para,
        autohide: s.sra_autohide, autohideTimeout: s.sra_autohide_timeout,
        pinDefault: s.sra_pin_default, debug: s.sra_debug,
      }, () => { if (chrome.runtime.lastError) {} });
      if (debugTogglePopup.checked !== undefined)
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
  [eyeToggle, selToggle, highlightToggle, pinDefaultToggle, debugTogglePopup, idleBlinkToggle, comprehensionToggle]
    .filter(Boolean).forEach(el => el.addEventListener('change', saveAndBroadcast));
  backendUrlInput.addEventListener('change', saveAndBroadcast);
  autohideTimeout.addEventListener('change', saveAndBroadcast);

  // Eye toggle also starts camera
  eyeToggle.addEventListener('change', () => {
    if (eyeToggle.checked) {
      setCameraStatus('loading', 'starting…');
      sendToTab({ type: 'startCamera' }, () => {});
    } else {
      setCameraStatus('', 'camera off');
    }
  });

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
      if (err) {
        setCameraStatus('error', 'no content script — reload page');
      }
      // Camera status will update via storage listener when cameraReady fires
    });
  });

  calibrateBtn.addEventListener('click', async () => {
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
    calibrateBtn.textContent = 'Calibrate Eye Tracker';
  });

  troubleshootBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/content/camera' });
  });

  upgradeBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/upgrade.html') });
  });


  // ── Notes button ──────────────────────────────────────────────────────
  const notesBtn = document.getElementById('notesBtn');
  notesBtn && notesBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/notes.html') });
  });

});

  // ── Logo: set via chrome.runtime.getURL as a reliable fallback ─────────
  try {
    const logoImg = document.getElementById('sra-logo-img');
    if (logoImg) logoImg.src = chrome.runtime.getURL('assets/tldr.png');
  } catch (e) {}

  // ── Demo test buttons: force a cognitive state trigger ──────────────────
  const testConfusedBtn   = document.getElementById('testConfusedBtn');
  const testOverloadedBtn = document.getElementById('testOverloadedBtn');

  function simulateState(state) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs?.[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'simulateState', state }, (resp) => {
        if (chrome.runtime.lastError) {
          alert('No content script on this page. Navigate to a page with text first.');
        }
      });
    });
  }

  testConfusedBtn   && testConfusedBtn.addEventListener('click',   () => simulateState('confused'));
  testOverloadedBtn && testOverloadedBtn.addEventListener('click',  () => simulateState('overloaded'));