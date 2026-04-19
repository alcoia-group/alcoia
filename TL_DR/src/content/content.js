/*
  content.js — TL;DR Extension Core
  Orchestrates: WebGazer → Feature Extraction → Classifier → AI Popup
  
  Pipeline:
    gaze point → gaze-features.js (windowed stats)
                → classifier.js  (decision tree → cognitive state)
                  → 'confused' or 'overloaded' → fetchSummary → popup
                  → 'zoning_out' → focus nudge
                  → 'focused'/'skimming' → no action
*/

// Internal debug logger — only logs TL;DR events, not every page message
const log = (...a) => console.log('[TL;DR]', ...a);
const warn = (...a) => console.warn('[TL;DR]', ...a);

(async function () {
  // ── Constants ───────────────────────────────────────────────────────────────
  const BACKEND_DEFAULT = 'http://localhost:3000/api/summarize';
  const MIN_SELECTION_CHARS = 15;
  const CLASSIFY_INTERVAL_MS = 2500;   // how often to run classifier
  const POPUP_ID = 'sra-floating-popup';

  // ── Runtime state ────────────────────────────────────────────────────────────
  let backendUrl = BACKEND_DEFAULT;
  let eyeTrackingEnabled = true;
  let selectionEnabled = true;
  let autohideEnabled = false;
  let autohideTimeoutSec = 12;
  let pinDefault = false;
  let debugEnabled = false;
  let lastCognitiveState = 'focused';
  let lastActionAt = 0;          // throttle: don't trigger more often than every 8s
  const ACTION_COOLDOWN_MS = 8000;

  let pdfHandler = null;
  let pptxHandler = null;

  // ── Module loader ─────────────────────────────────────────────────────────────
  const loadModule = async (path) => {
    const url = chrome.runtime.getURL(path);
    return await import(url);
  };

  // ── Inject shared CSS ─────────────────────────────────────────────────────────
  const injectCss = (p) => {
    if (document.querySelector(`link[href*="${p}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL(p);
    document.head.appendChild(link);
  };
  injectCss('src/styles/overlay.css');

  // ── Load helper modules ────────────────────────────────────────────────────────
  const gazeUtils    = await loadModule('src/content/gaze-utils.js');
  const overlayUtils = await loadModule('src/content/overlay-utils.js');
  const featModule   = await loadModule('src/content/gaze-features.js');
  const classModule  = await loadModule('src/content/classifier.js');

  const featureExtractor = featModule.createFeatureExtractor({ windowMs: 2500, minPoints: 15 });
  const { classifyGazeState, COGNITIVE_STATE_ACTIONS } = classModule;

  // ── Load settings ────────────────────────────────────────────────────────────
  chrome.storage.local.get(
    { sra_backend_url: BACKEND_DEFAULT, sra_eye: true, sra_selection: true,
      sra_autohide: false, sra_autohide_timeout: 12, sra_pin_default: false, sra_debug: false },
    (res) => {
      backendUrl         = res.sra_backend_url || BACKEND_DEFAULT;
      eyeTrackingEnabled = res.sra_eye !== false;
      selectionEnabled   = res.sra_selection !== false;
      autohideEnabled    = !!res.sra_autohide;
      autohideTimeoutSec = res.sra_autohide_timeout || 12;
      pinDefault         = !!res.sra_pin_default;
      debugEnabled       = !!res.sra_debug;
    }
  );

  // ── Utility helpers ───────────────────────────────────────────────────────────
  function escapeHtml(s = '') {
    return s.replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── AI fetch ──────────────────────────────────────────────────────────────────
  async function fetchSummary(text, mode = 'tldr') {
    try {
      const resp = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode }),
      });
      const j = await resp.json();
      return j.summary || j.result || 'No summary returned.';
    } catch (e) {
      warn('AI fetch failed — is the backend running? (cd server && node index.js)', e.message);
      return '⚠️ Could not reach AI backend. Make sure `node server/index.js` is running.';
    }
  }

  // ── Popup system ──────────────────────────────────────────────────────────────
  function createPopupRoot() {
    let node = document.getElementById(POPUP_ID);
    if (node) return node;
    node = document.createElement('div');
    node.id = POPUP_ID;
    node.className = 'sra-popup';
    node.style.display = 'none';
    node.style.position = 'absolute';
    document.body.appendChild(node);
    return node;
  }

  function setPin(root, pinned) {
    if (!root) return;
    if (pinned) {
      const r = root.getBoundingClientRect();
      root.style.position = 'fixed';
      root.style.left = Math.round(r.left) + 'px';
      root.style.top  = Math.round(r.top)  + 'px';
      root.dataset.pinned = 'true';
      chrome.storage.local.set({ sra_pinned_popup: { pinned: true, left: Math.round(r.left), top: Math.round(r.top) } });
    } else {
      delete root.dataset.pinned;
      root.style.position = '';
      root.style.left = '';
      root.style.top  = '';
      chrome.storage.local.remove('sra_pinned_popup');
    }
  }

  function applySavedPin(root) {
    chrome.storage.local.get(['sra_pinned_popup'], (res) => {
      const cfg = res && res.sra_pinned_popup;
      if (!cfg || !cfg.pinned) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = root.offsetWidth || 200, h = root.offsetHeight || 100;
      root.style.position = 'fixed';
      root.style.left = clamp(cfg.left || 8, 8, vw - w - 8) + 'px';
      root.style.top  = clamp(cfg.top  || 8, 8, vh - h - 8) + 'px';
      root.dataset.pinned = 'true';
      const pb = root.querySelector('.sra-pin');
      if (pb) pb.classList.add('active');
    });
  }

  if (!window.__sra_pinned_resize_handler_installed) {
    window.__sra_pinned_resize_handler_installed = true;
    window.addEventListener('resize', () => {
      const root = document.getElementById(POPUP_ID);
      if (root && root.dataset && root.dataset.pinned === 'true') applySavedPin(root);
    });
  }

  function renderPopup(x, y, html, meta = {}) {
    const root = createPopupRoot();
    const prevPinned = root.dataset && root.dataset.pinned === 'true';

    // Build content with a badge showing what triggered this
    const badge = meta.trigger
      ? `<span class="sra-state-badge sra-state-${meta.trigger}">${meta.triggerLabel || meta.trigger}</span>`
      : '';

    root.innerHTML = `<div class="sra-popup-body">${badge}${html}</div>`;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sra-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&#10005;';
    closeBtn.onclick = () => overlayUtils.hidePopup(root);
    root.appendChild(closeBtn);

    // Pin button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'sra-pin';
    pinBtn.setAttribute('aria-label', 'Pin');
    pinBtn.innerHTML = '📌';
    if (prevPinned || pinDefault) { root.dataset.pinned = 'true'; pinBtn.classList.add('active'); }
    pinBtn.onclick = () => {
      const pinned = root.dataset && root.dataset.pinned === 'true';
      setPin(root, !pinned);
      pinBtn.classList.toggle('active', !pinned);
    };
    root.appendChild(pinBtn);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'sra-actions';

    const explainBtn = document.createElement('button');
    explainBtn.className = 'sra-btn sra-btn-primary';
    explainBtn.textContent = 'Explain More';
    explainBtn.onclick = async () => {
      explainBtn.disabled = true;
      explainBtn.textContent = 'Thinking…';
      const s = await fetchSummary(meta.text || '', 'explain_more');
      root.querySelector('.sra-popup-body').innerHTML = badge + escapeHtml(s);
      explainBtn.textContent = 'Explain More';
      explainBtn.disabled = false;
    };

    const noteBtn = document.createElement('button');
    noteBtn.className = 'sra-btn sra-btn-secondary';
    noteBtn.textContent = 'Save Note';
    noteBtn.onclick = () => {
      chrome.runtime.sendMessage({ action: 'saveNote', note: { text: meta.text || '', meta } });
      noteBtn.textContent = 'Saved ✓';
      noteBtn.disabled = true;
    };

    actions.appendChild(explainBtn);
    actions.appendChild(noteBtn);
    root.appendChild(actions);

    overlayUtils.placePopup(root, { x, y, avoidSelection: true });

    try { applySavedPin(root); } catch (e) {}
    try { if (pinDefault && !prevPinned) setPin(root, true); } catch (e) {}

    // Auto-hide
    clearTimeout(root._hideT);
    if (!root.dataset || root.dataset.pinned !== 'true') {
      if (autohideEnabled) {
        root._hideT = setTimeout(() => overlayUtils.hidePopup(root), Math.max(3, autohideTimeoutSec) * 1000);
      }
    }

    if (!window.__sra_popup_key_handler_installed) {
      window.__sra_popup_key_handler_installed = true;
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          const r = document.getElementById(POPUP_ID);
          if (r && r.dataset && r.dataset.pinned === 'true') return;
          overlayUtils.hidePopup(r);
        }
      });
    }
  }

  // ── Focus nudge (for zoning-out state) ──────────────────────────────────────
  function showFocusNudge(currentEl) {
    const existing = document.getElementById('sra-focus-nudge');
    if (existing) existing.remove();
    if (!currentEl) return;
    currentEl.style.outline = '2px solid rgba(99,102,241,0.6)';
    currentEl.style.borderRadius = '3px';
    setTimeout(() => {
      try { currentEl.style.outline = ''; currentEl.style.borderRadius = ''; } catch (e) {}
    }, 3000);
  }

  // ── Selection TL;DR ──────────────────────────────────────────────────────────
  document.addEventListener('mouseup', async (ev) => {
    if (!selectionEnabled) return;

    let selected = '';
    if (pdfHandler  && pdfHandler.extractSelectedText)  selected = await pdfHandler.extractSelectedText();
    if (!selected && pptxHandler && pptxHandler.extractSelectedText) selected = await pptxHandler.extractSelectedText();
    if (!selected) selected = (window.getSelection && window.getSelection().toString().trim()) || '';
    if (!selected || selected.length < MIN_SELECTION_CHARS) return;

    // Code vs text detection
    function isLikelyCode(str) {
      const codeKw = /\b(function|var|let|const|if|else|for|while|return|class|def|import|public|static|void|=>|async|await|#include)\b/;
      const braces = (str.match(/[{};]/g) || []).length;
      const kwHits = (str.match(codeKw) || []).length;
      let inCode = false;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          let node = sel.anchorNode;
          while (node) {
            if (node.nodeType === 1 && (node.nodeName === 'PRE' || node.nodeName === 'CODE')) { inCode = true; break; }
            node = node.parentNode;
          }
        }
      } catch (e) {}
      return inCode || braces > 2 || kwHits > 1;
    }

    const mode = isLikelyCode(selected) ? 'explain_code' : 'tldr';
    const sum  = await fetchSummary(selected, mode);

    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect && (rect.width || rect.height)) {
          renderPopup(Math.min(window.innerWidth - 24, rect.right + 8), Math.max(8, rect.top),
            `<div>${escapeHtml(sum)}</div>`, { text: selected, source: 'selection', mode });
          return;
        }
      }
    } catch (e) {}
    renderPopup(ev.clientX + 12, ev.clientY + 12, `<div>${escapeHtml(sum)}</div>`,
      { text: selected, source: 'selection', mode });
  });

  // ── Paragraph finder ─────────────────────────────────────────────────────────
  async function findParagraphAt(clientX, clientY) {
    if (pdfHandler  && pdfHandler.findParagraphAt)  { const p = await pdfHandler.findParagraphAt(clientX, clientY);  if (p) return { type: 'pdf',  data: p }; }
    if (pptxHandler && pptxHandler.findParagraphAt) { const p = await pptxHandler.findParagraphAt(clientX, clientY); if (p) return { type: 'pptx', data: p }; }
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    const block = overlayUtils.getBlockAncestor(el) || el;
    return { type: 'dom', data: block };
  }

  async function triggerAIForParagraph(paragraphInfo, triggerReason) {
    if (!paragraphInfo) return;
    let text = '';
    if (paragraphInfo.type === 'dom') text = (paragraphInfo.data && (paragraphInfo.data.innerText || paragraphInfo.data.textContent)) || '';
    else if (paragraphInfo.type === 'pdf')  text = await pdfHandler.getParagraphText(paragraphInfo.data);
    else if (paragraphInfo.type === 'pptx') text = await pptxHandler.getParagraphText(paragraphInfo.data);
    if (!text || text.trim().length < 25) return;

    // Choose AI mode based on cognitive state
    const mode = triggerReason === 'overloaded' ? 'simplify' :
                 triggerReason === 'confused'   ? 'explain_more' : 'tldr';
    const summary = await fetchSummary(text, mode);

    let clientRect = { left: 60, top: 60, right: 200, bottom: 140 };
    if (paragraphInfo.type === 'dom') clientRect = paragraphInfo.data.getBoundingClientRect();
    else if (paragraphInfo.data && paragraphInfo.data.rect) clientRect = paragraphInfo.data.rect;

    renderPopup(
      Math.max(8, clientRect.right + 8),
      Math.max(8, clientRect.top),
      `<div>${escapeHtml(summary)}</div>`,
      {
        text,
        source: 'gaze',
        trigger: triggerReason,
        triggerLabel: { confused: '🤔 Confused', overloaded: '🧠 Overloaded', zoning_out: '💤 Zoning Out' }[triggerReason] || triggerReason,
      }
    );
  }

  // ── Gaze state smoothing ────────────────────────────────────────────────────
  const gazeState = gazeUtils.createGazeState({ smoothingAlpha: 0.18, dropoutFrames: 3, velocityThreshold: 1200 });
  let consecutiveNull = 0;
  let lastGazePt = null;
  let classifyTimer = null;
  let currentParagraph = null;

  async function onGaze(data) {
    if (!eyeTrackingEnabled) return;
    if (!data) {
      consecutiveNull++;
      if (consecutiveNull >= gazeState.dropoutFrames) { lastGazePt = null; }
      return;
    }
    consecutiveNull = 0;

    const pt = gazeUtils.normalizeAndSmooth(data, gazeState);
    if (!pt) return;
    pt.x = clamp(pt.x, 0, window.innerWidth - 1);
    pt.y = clamp(pt.y, 0, window.innerHeight - 1);
    if (!gazeUtils.checkVelocity(gazeState, pt)) return;

    lastGazePt = pt;
    featureExtractor.addPoint(pt);

    // Keep track of the paragraph under gaze for the action handler
    try {
      const found = await findParagraphAt(pt.x, pt.y);
      if (found) currentParagraph = found;
    } catch (e) {}
  }

  // ── Periodic classification ────────────────────────────────────────────────
  function startClassificationLoop() {
    if (classifyTimer) return;
    classifyTimer = setInterval(async () => {
      if (!eyeTrackingEnabled || !lastGazePt) return;

      const features = featureExtractor.computeFeatures();
      if (!features) return;

      const { label, confidence } = classifyGazeState(features);
      lastCognitiveState = label;

      if (debugEnabled) {
        log(`State: ${label} (${(confidence * 100).toFixed(0)}%)`, features);
      }

      const action = COGNITIVE_STATE_ACTIONS[label];
      const now = Date.now();
      if (action === 'none' || (now - lastActionAt) < ACTION_COOLDOWN_MS) return;

      lastActionAt = now;

      if (action === 'explain' || action === 'simplify') {
        await triggerAIForParagraph(currentParagraph, label);
      } else if (action === 'nudge') {
        showFocusNudge(currentParagraph && currentParagraph.type === 'dom' ? currentParagraph.data : null);
      }
    }, CLASSIFY_INTERVAL_MS);
  }

  // ── WebGazer bootstrap (CSP-safe: no inline scripts) ─────────────────────────
  async function startTracker() {
    if (window.__sra_tracker_started) return;
    window.__sra_tracker_started = true;

    try {
      const webgazerUrl = chrome.runtime.getURL('src/libs/webgazer.min.js');

      // Pass URL via data attribute — avoids any inline JS (CSP-safe)
      const bootstrapScript = document.createElement('script');
      bootstrapScript.dataset.webgazerUrl = webgazerUrl;
      bootstrapScript.src = chrome.runtime.getURL('src/content/webgazer-bootstrap.js');
      (document.head || document.documentElement).appendChild(bootstrapScript);

      // Fallback: if bootstrap doesn't report ready within 5s, ask background
      let cameraReady = false;
      const fallbackTimer = setTimeout(() => {
        if (cameraReady) return;
        warn('No cameraReady signal — requesting privileged injection via background...');
        try {
          chrome.runtime.sendMessage({ action: 'injectWebgazerBootstrap' }, (resp) => {
            if (chrome.runtime.lastError) warn('Privileged injection error:', chrome.runtime.lastError.message);
            else log('Privileged injection response:', resp);
          });
        } catch (e) { warn('Could not send injectWebgazerBootstrap:', e); }
      }, 5000);

      // Forward gaze events + control messages
      window.addEventListener('message', async (event) => {
        if (event.source !== window || !event.data) return;
        const d = event.data;

        if (d.source === 'sra-webgazer') {
          try { if (d.gaze) onGaze(d.gaze); } catch (e) {}
          return;
        }

        if (d.source === 'sra-control' && d.type === 'cameraReady') {
          cameraReady = true;
          clearTimeout(fallbackTimer);
          log('WebGazer ready ✓');

          // Calibration after camera settles
          setTimeout(async () => {
            try {
              const cal = await gazeUtils.runCalibrationSequence();
              if (cal) {
                await gazeUtils.setCalibration(cal);
                log('Calibration complete:', cal);
              }
              startClassificationLoop();
            } catch (e) {
              warn('Calibration failed (non-fatal):', e);
              startClassificationLoop(); // still start classifier even if calibration fails
            }
          }, 800);
        }
      }, false);

    } catch (e) { warn('startTracker failed:', e); }
  }

  // ── Click recording (improves WebGazer's model) ───────────────────────────────
  document.addEventListener('click', (e) => {
    try {
      if (window.webgazer) webgazer.recordScreenPosition(e.clientX, e.clientY, 'click');
    } catch (e) {}
  });

  // ── PDF / PPTX handlers ───────────────────────────────────────────────────────
  async function detectAndInitHandlers() {
    const url = window.location.href;
    const hasPdfEmbed = !!document.querySelector('embed[type="application/pdf"], iframe[src$=".pdf"], object[type="application/pdf"]');
    if (hasPdfEmbed || /\.pdf($|[?#])/i.test(url)) {
      try { const mod = await loadModule('src/content/pdf-handler.js'); pdfHandler = await mod.initPDFHandler({ backendUrl, fetchSummary, renderPopup }); } catch (e) { warn('PDF handler failed:', e); }
    }
    if (/\.pptx($|[?#])/i.test(url) || !!document.querySelector('a[href$=".pptx"]')) {
      try { const mod = await loadModule('src/content/pptx-handler.js'); pptxHandler = await mod.initPPTXHandler({ backendUrl, fetchSummary, renderPopup }); } catch (e) { warn('PPTX handler failed:', e); }
    }
  }

  // ── Extension API (popup → content) ─────────────────────────────────────────
  window.sra = window.sra || {};
  window.sra.runCalibration = async () => {
    try {
      const cal = await gazeUtils.runCalibrationSequence();
      if (cal) await gazeUtils.setCalibration(cal);
      return cal;
    } catch (e) { warn('Calibration failed:', e); return null; }
  };
  window.sra.getState = () => lastCognitiveState;

  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'settings') {
      if (typeof msg.eye      !== 'undefined') eyeTrackingEnabled = !!msg.eye;
      if (typeof msg.selection !== 'undefined') selectionEnabled   = !!msg.selection;
      if (msg.backendUrl)                        backendUrl          = msg.backendUrl;
      if (typeof msg.autohide !== 'undefined') autohideEnabled     = !!msg.autohide;
      if (typeof msg.autohideTimeout !== 'undefined') autohideTimeoutSec = Number(msg.autohideTimeout) || 12;
      if (typeof msg.pinDefault !== 'undefined') pinDefault          = !!msg.pinDefault;
      if (typeof msg.debug    !== 'undefined') debugEnabled         = !!msg.debug;
      try { window.postMessage({ source: 'sra-control', type: 'setPredictionPoints', enabled: !!debugEnabled }, '*'); } catch (e) {}
      sendResponse({ status: 'ok' });
      return;
    }

    if (msg.type === 'runCalibration') {
      (async () => {
        try {
          const cal = await gazeUtils.runCalibrationSequence();
          if (cal) await gazeUtils.setCalibration(cal);
          sendResponse({ status: 'ok', calibration: cal });
        } catch (e) { sendResponse({ status: 'error', error: String(e) }); }
      })();
      return true;
    }

    if (msg.type === 'debugToggle') {
      debugEnabled = !!msg.enabled;
      try { window.postMessage({ source: 'sra-control', type: 'setPredictionPoints', enabled: debugEnabled }, '*'); } catch (e) {}
      sendResponse({ status: 'ok' });
      return true;
    }

    if (msg.type === 'startCamera') {
      try {
        window.__sra_tracker_started = false; // allow restart
        await startTracker();
        window.postMessage({ source: 'sra-control', type: 'setPredictionPoints', enabled: true }, '*');
        sendResponse({ status: 'ok' });
      } catch (e) { sendResponse({ status: 'error', error: String(e) }); }
      return true;
    }

    if (msg.type === 'getState') {
      sendResponse({ state: lastCognitiveState });
      return;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────────
  await detectAndInitHandlers();
  await startTracker();

  log('Content script loaded ✓');

})();