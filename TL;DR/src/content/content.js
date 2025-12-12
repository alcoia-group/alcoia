/*
  Content script: Injects WebGazer, maps gaze to paragraphs/text layers,
  triggers AI summary on dwell, detects selection TL;DR, and shows floating popup.

  Notes:
  - This is an MVP implementation. It loads WebGazer from CDN.
  - Backend endpoint default: http://localhost:3000/api/summarize (changeable via popup settings)
*/

/*
  content.js — orchestrates gaze tracking, handlers, and UI placement.
  Uses modular helpers: gaze-utils.js, overlay-utils.js, pdf-handler.js, pptx-handler.js
  Expects vendor libraries to be present under `src/libs/*` for pdf.js and jszip.
*/

(async function () {
  const BACKEND_DEFAULT = 'http://localhost:3000/api/summarize';
  const DWELL_THRESHOLD_MS = 1500;
  const MIN_SELECTION_CHARS = 15;

  // runtime state
  let backendUrl = BACKEND_DEFAULT;
  let eyeTrackingEnabled = true;
  let selectionEnabled = true;
  // keep popups persistent by default unless user enables autohide in the popup
  let autohideEnabled = false;
  let autohideTimeoutSec = 12;
  let pinDefault = false;
  let debugEnabled = false;

  // handlers
  let pdfHandler = null;
  let pptxHandler = null;

  // modules (loaded dynamically)
  const loadModule = async (path) => {
    // Use the full chrome-extension URL to import modules directly.
    // Avoid creating blob: URLs which some pages block via CSP.
    const url = chrome.runtime.getURL(path);
    return await import(url);
  };

  // inject shared styles
  const injectCss = (p) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL(p);
    document.head.appendChild(link);
  };
  injectCss('src/styles/overlay.css');

  // load helper modules
  const gazeUtils = await loadModule('src/content/gaze-utils.js');
  const overlayUtils = await loadModule('src/content/overlay-utils.js');

  // read settings
  chrome.storage.local.get({ sra_backend_url: BACKEND_DEFAULT, sra_eye: true, sra_selection: true, sra_autohide: false, sra_autohide_timeout: 12, sra_pin_default: false, sra_debug: false }, (res) => {
    backendUrl = res.sra_backend_url || BACKEND_DEFAULT;
    eyeTrackingEnabled = res.sra_eye !== false;
    selectionEnabled = res.sra_selection !== false;
    autohideEnabled = res.sra_autohide !== false;
    autohideTimeoutSec = res.sra_autohide_timeout || 12;
    pinDefault = !!res.sra_pin_default;
    debugEnabled = !!res.sra_debug;
  });

  // small UI helpers
  const POPUP_ID = 'sra-floating-popup';
  function createPopupRoot() {
    let node = document.getElementById(POPUP_ID);
    if (node) return node;
    node = document.createElement('div');
    node.id = POPUP_ID; node.className = 'sra-popup'; node.style.display = 'none'; node.style.position = 'absolute';
    document.body.appendChild(node);
    return node;
  }

  function escapeHtml(s = '') { return s.replace(/[&<>\"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":"&#39;" })[c]); }

  async function fetchSummary(text, mode = 'tldr') {
    try {
      const resp = await fetch(backendUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mode }) });
      const j = await resp.json(); return j.summary || j.result || 'No summary returned.';
    } catch (e) { console.error('Summary fetch failed', e); return 'Could not reach AI backend.'; }
  }

  // Pin helpers: allow a popup to be fixed to viewport coordinates and persist its position
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function setPin(root, pinned) {
    try {
      if (!root) return;
      if (pinned) {
        const r = root.getBoundingClientRect();
        const left = Math.round(r.left);
        const top = Math.round(r.top);
        root.style.position = 'fixed';
        root.style.left = left + 'px';
        root.style.top = top + 'px';
        root.dataset.pinned = 'true';
        // persist the pinned coords so they can be reapplied later
        chrome.storage.local.set({ sra_pinned_popup: { pinned: true, left, top } });
      } else {
        // unpin: clear fixed positioning and stored state
        delete root.dataset.pinned;
        root.style.position = '';
        root.style.left = '';
        root.style.top = '';
        chrome.storage.local.remove('sra_pinned_popup');
      }
    } catch (e) { /* noop */ }
  }

  function applySavedPin(root) {
    try {
      if (!root) return;
      chrome.storage.local.get(['sra_pinned_popup'], (res) => {
        const cfg = res && res.sra_pinned_popup;
        if (!cfg || !cfg.pinned) return;
        const vw = window.innerWidth; const vh = window.innerHeight;
        const w = root.offsetWidth || 200; const h = root.offsetHeight || 100;
        const left = clamp(cfg.left || 8, 8, Math.max(8, vw - w - 8));
        const top = clamp(cfg.top || 8, 8, Math.max(8, vh - h - 8));
        root.style.position = 'fixed';
        root.style.left = left + 'px';
        root.style.top = top + 'px';
        root.dataset.pinned = 'true';
        // mark pin button active if present
        const pb = root.querySelector('.sra-pin'); if (pb) pb.classList.add('active');
      });
    } catch (e) { /* ignore */ }
  }

  // keep pinned popup clamped on resize
  if (!window.__sra_pinned_resize_handler_installed) {
    window.__sra_pinned_resize_handler_installed = true;
    window.addEventListener('resize', () => {
      const root = document.getElementById(POPUP_ID);
      if (!root || !(root.dataset && root.dataset.pinned === 'true')) return;
      // re-apply saved pin to clamp in viewport
      applySavedPin(root);
    });
  }

  // show popup using overlay-utils placement logic
  function renderPopup(x, y, html, meta = {}) {
    const root = createPopupRoot();
    // Build popup with persistent close & pin controls (behavior configurable)
    // preserve previous pinned state if present
    const prevPinned = root.dataset && root.dataset.pinned === 'true';
    root.innerHTML = `<div class="sra-popup-body">${html}</div>`;
    // close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sra-close';
    closeBtn.setAttribute('aria-label', 'Close summary');
    closeBtn.innerHTML = '&#10005;';
    closeBtn.onclick = () => overlayUtils.hidePopup(root);
    root.appendChild(closeBtn);
  // pin button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'sra-pin';
    pinBtn.setAttribute('aria-label', 'Pin summary');
    pinBtn.innerHTML = '📌';
  if (prevPinned || pinDefault) { root.dataset.pinned = 'true'; pinBtn.classList.add('active'); }
    pinBtn.onclick = () => {
      const pinned = root.dataset && root.dataset.pinned === 'true';
      // toggle and persist
      setPin(root, !pinned);
      if (!pinned) pinBtn.classList.add('active'); else pinBtn.classList.remove('active');
    };
    root.appendChild(pinBtn);

    const actions = document.createElement('div'); actions.className = 'sra-actions';
    const explain = document.createElement('button'); explain.className = 'sra-btn sra-btn-primary'; explain.textContent = 'Explain More';
    explain.onclick = async () => { explain.disabled = true; const s = await fetchSummary(meta.text||'', 'explain_more'); root.querySelector('.sra-popup-body').innerHTML = escapeHtml(s); explain.disabled = false; };
    const note = document.createElement('button'); note.className = 'sra-btn sra-btn-secondary'; note.textContent = 'Add to Notes'; note.onclick = () => { chrome.runtime.sendMessage({ action: 'saveNote', note: { text: meta.text||'', meta } }); note.textContent = 'Saved'; note.disabled = true; };
    actions.appendChild(explain); actions.appendChild(note); root.appendChild(actions);
  overlayUtils.placePopup(root, { x, y, avoidSelection: true });
  // If user previously pinned the popup, reapply saved fixed coords now that size/position is known
  try { applySavedPin(root); } catch (e) { /* ignore */ }
  // If default pin requested (from settings) persist current placement
  try { if (pinDefault && !prevPinned) setPin(root, true); } catch (e) {}

    // auto-hide logic: controlled by settings read earlier into variables
    try {
      clearTimeout(root._hideT);
      if (!root.dataset || root.dataset.pinned !== 'true') {
        // read autohide settings - fall back to defaults
        const autohide = (typeof autohideEnabled !== 'undefined') ? autohideEnabled : true;
        const timeoutSec = (typeof autohideTimeoutSec !== 'undefined') ? autohideTimeoutSec : 12;
        if (autohide) {
          root._hideT = setTimeout(() => { overlayUtils.hidePopup(root); }, Math.max(3, timeoutSec) * 1000);
        }
      }
    } catch (e) { /* ignore timing errors */ }

    // install Escape key handler once to dismiss popup (unless pinned)
    if (!window.__sra_popup_key_handler_installed) {
      window.__sra_popup_key_handler_installed = true;
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' || ev.key === 'Esc') {
          const rootEl = document.getElementById(POPUP_ID);
          if (rootEl && rootEl.dataset && rootEl.dataset.pinned === 'true') return;
          overlayUtils.hidePopup(rootEl);
        }
      });
    }
  }

  // selection TL;DR handler
  document.addEventListener('mouseup', async (ev) => {
    if (!selectionEnabled) return;
    let selected = '';
    if (pdfHandler && pdfHandler.extractSelectedText) selected = await pdfHandler.extractSelectedText();
    if (!selected && pptxHandler && pptxHandler.extractSelectedText) selected = await pptxHandler.extractSelectedText();
    if (!selected) selected = window.getSelection ? window.getSelection().toString().trim() : '';
    if (selected && selected.length >= MIN_SELECTION_CHARS) {
      // --- CODE DETECTION LOGIC ---
      function isLikelyCode(str) {
        // Heuristics: lots of braces, semicolons, indentation, keywords, or inside <pre>/<code>
        const codeKeywords = /\b(function|var|let|const|if|else|for|while|return|class|def|import|public|private|static|void|int|float|String|=>|#include|using|try|catch|finally|async|await)\b/;
        const lines = str.split('\n');
        const avgIndent = lines.reduce((a, l) => a + (/^\s+/.test(l) ? 1 : 0), 0) / Math.max(1, lines.length);
        const braceCount = (str.match(/[{};]/g) || []).length;
        const keywordCount = (str.match(codeKeywords) || []).length;
        // If selection is inside <pre> or <code> element
        let inCodeBlock = false;
        try {
          const sel = window.getSelection && window.getSelection();
          if (sel && sel.rangeCount > 0) {
            let node = sel.anchorNode;
            while (node) {
              if (node.nodeType === 1 && (node.nodeName === 'PRE' || node.nodeName === 'CODE')) { inCodeBlock = true; break; }
              node = node.parentNode;
            }
          }
        } catch (e) {}
        return inCodeBlock || braceCount > 2 || keywordCount > 1 || avgIndent > 0.2;
      }

      const mode = isLikelyCode(selected) ? 'explain_code' : 'tldr';
      const sum = await fetchSummary(selected, mode);
      // attempt to place popup near the selection bounding rect when possible (more reliable than mouse coords)
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect && (rect.width || rect.height)) {
            const px = Math.min(window.innerWidth - 24, Math.max(8, rect.right + 8));
            const py = Math.max(8, rect.top);
            renderPopup(px, py, `<div>${escapeHtml(sum)}</div>`, { text: selected, source: 'selection', mode });
          } else {
            renderPopup(ev.clientX + 12, ev.clientY + 12, `<div>${escapeHtml(sum)}</div>`, { text: selected, source: 'selection', mode });
          }
        } else {
          renderPopup(ev.clientX + 12, ev.clientY + 12, `<div>${escapeHtml(sum)}</div>`, { text: selected, source: 'selection', mode });
        }
      } catch (e) {
        renderPopup(ev.clientX + 12, ev.clientY + 12, `<div>${escapeHtml(sum)}</div>`, { text: selected, source: 'selection', mode });
      }
    }
  });

  // paragraph detection orchestrator
  async function findParagraphAt(clientX, clientY) {
    if (pdfHandler && pdfHandler.findParagraphAt) {
      const p = await pdfHandler.findParagraphAt(clientX, clientY);
      if (p) return { type: 'pdf', data: p };
    }
    if (pptxHandler && pptxHandler.findParagraphAt) {
      const p = await pptxHandler.findParagraphAt(clientX, clientY);
      if (p) return { type: 'pptx', data: p };
    }
    // fallback DOM
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    const block = overlayUtils.getBlockAncestor(el) || el;
    return { type: 'dom', data: block };
  }

  // trigger summary for paragraph info
  async function triggerSummaryForParagraph(paragraphInfo) {
    if (!paragraphInfo) return;
    let text = '';
    if (paragraphInfo.type === 'dom') text = paragraphInfo.data && (paragraphInfo.data.innerText || paragraphInfo.data.textContent) || '';
    else if (paragraphInfo.type === 'pdf') text = await pdfHandler.getParagraphText(paragraphInfo.data);
    else if (paragraphInfo.type === 'pptx') text = await pptxHandler.getParagraphText(paragraphInfo.data);
    if (!text || text.trim().length < 25) return;
    const summary = await fetchSummary(text, 'tldr');
    // recalc rect before placement
    let clientRect = { left: 60, top: 60, right: 200, bottom: 140 };
    if (paragraphInfo.type === 'dom') clientRect = paragraphInfo.data.getBoundingClientRect();
    else if (paragraphInfo.data && paragraphInfo.data.rect) clientRect = paragraphInfo.data.rect;
    const px = Math.max(8, clientRect.right + 8); const py = Math.max(8, clientRect.top);
    renderPopup(px, py, `<div>${escapeHtml(summary)}</div>`, { text, source: 'gaze' });
  }

  // gaze processing: get normalized client coords, smoothing, dwell detection
  const gazeState = gazeUtils.createGazeState({ smoothingAlpha: 0.18, dropoutFrames: 3, velocityThreshold: 1200 });
  let currentKey = null; let startAt = 0; let consecutiveNull = 0;

  async function onGaze(data) {
    if (!eyeTrackingEnabled) return;
    if (!data) { consecutiveNull++; if (consecutiveNull < gazeState.dropoutFrames) return; currentKey = null; startAt = 0; return; }
    consecutiveNull = 0;
    // normalize to client coords and apply calibration + smoothing
    const pt = gazeUtils.normalizeAndSmooth(data, gazeState);
    // clamp
    pt.x = Math.max(0, Math.min(window.innerWidth - 1, pt.x)); pt.y = Math.max(0, Math.min(window.innerHeight - 1, pt.y));
    // velocity filter
    if (!gazeUtils.checkVelocity(gazeState, pt)) return;
    // find paragraph
    const found = await findParagraphAt(pt.x, pt.y);
    if (!found) { currentKey = null; startAt = 0; return; }
    const key = found.type + '::' + (found.type === 'dom' ? (found.data && (found.data.__sra_id || (found.data.__sra_id = Math.random().toString(36).slice(2)))) : (found.data && found.data.id || JSON.stringify(found.data)));
    if (currentKey !== key) { currentKey = key; startAt = performance.now(); return; }
    const now = performance.now();
    if (now - startAt >= DWELL_THRESHOLD_MS) { startAt = now + 800; triggerSummaryForParagraph(found); }
  }

  // Start webgazer (or other callback provider)
  async function startTracker() {
    try {
      // Inject a small bootstrap into the page that loads the vendor webgazer script
      // and forwards gaze events to the content script via window.postMessage.
      const webgazerUrl = chrome.runtime.getURL('src/libs/webgazer.min.js');
      const bootstrap = `(() => {
        try {
          if (window.__sra_webgazer_bootstrap_loaded) return;
          window.__sra_webgazer_bootstrap_loaded = true;
          const s = document.createElement('script');
          s.src = '${webgazerUrl}';
          s.onload = function(){
            try {
              if (typeof webgazer !== 'undefined'){
                webgazer.setRegression('ridge').setGazeListener(function(d){
                  try { window.postMessage({ source: 'sra-webgazer', gaze: d }, '*'); } catch(e){}
                }).begin();
                try { webgazer.showPredictionPoints(false); } catch(e){}
                window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
              } else {
                console.warn('webgazer not available after load');
              }
            } catch(e) { console.warn('webgazer init error', e); }
          };
          s.onerror = function(){ console.warn('Failed to load webgazer from ${webgazerUrl}'); };
          (document.head || document.documentElement).appendChild(s);
          // listen for control messages from the content script to toggle debug visuals
          window.addEventListener('message', function(ev){
            try {
              if (ev && ev.source === window && ev.data && ev.data.source === 'sra-control' && ev.data.type === 'setPredictionPoints') {
                if (typeof webgazer !== 'undefined' && typeof webgazer.showPredictionPoints === 'function') {
                  webgazer.showPredictionPoints(!!ev.data.enabled);
                }
              }
            } catch(e){}
          }, false);
        } catch(e) { console.warn('webgazer bootstrap failed', e); }
      })();`;

      const script = document.createElement('script');
      script.textContent = bootstrap;
      (document.head || document.documentElement).appendChild(script);
      // Remove injected node to keep DOM clean
      script.parentNode && script.parentNode.removeChild(script);

      // State tracking: did the page report camera readiness?
      let cameraReady = false;
      let cameraReadyTimer = setTimeout(() => {
        if (cameraReady) return;
        console.warn('Initial bootstrap did not report cameraReady; requesting privileged injection via background.');
        try {
          chrome.runtime.sendMessage({ action: 'injectWebgazerBootstrap' }, (resp) => {
            if (chrome.runtime.lastError) console.warn('injectWebgazerBootstrap error', chrome.runtime.lastError.message);
            else console.log('Requested privileged injection', resp);
          });
        } catch (e) { console.warn('Failed to request privileged injection', e); }
      }, 4000);

      // Listen for forwarded gaze messages from the page and camera-ready notifications
      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d) return;
        if (d.source === 'sra-webgazer') {
          try { if (d.gaze) onGaze(d.gaze); } catch (e) { /* ignore handler errors */ }
          return;
        }
        if (d.source === 'sra-control' && d.type === 'cameraReady') {
          cameraReady = true;
          clearTimeout(cameraReadyTimer);
          console.log('Webgazer reported cameraReady');
        }
      }, false);
    } catch (e) { console.warn('Tracker start failed', e); }
  }

  // detect and init handlers (PDF/PPTX)
  async function detectAndInitHandlers() {
    const url = window.location.href;
    const hasPdfEmbed = !!document.querySelector('embed[type="application/pdf"], iframe[src$=".pdf"], object[type="application/pdf"]');
    const isPdfByUrl = /\.pdf($|[?#])/i.test(url);
    const isPptxByUrl = /\.pptx($|[?#])/i.test(url);
    if (hasPdfEmbed || isPdfByUrl) {
      try { const mod = await loadModule('src/content/pdf-handler.js'); pdfHandler = await mod.initPDFHandler({ backendUrl, fetchSummary, renderPopup: renderPopup }); } catch (e) { console.warn('PDF handler load failed', e); }
    }
    if (isPptxByUrl || !!document.querySelector('a[href$=".pptx"]')) {
      try { const mod = await loadModule('src/content/pptx-handler.js'); pptxHandler = await mod.initPPTXHandler({ backendUrl, fetchSummary, renderPopup: renderPopup }); } catch (e) { console.warn('PPTX handler load failed', e); }
    }
  }

  // start
  await detectAndInitHandlers();
  await startTracker();

  // expose calibration API to popup executor and to page context via a safe bridge
  try {
    // 1) Content-script-visible API (isolated world) for internal callers
    window.sra = window.sra || {};
    window.sra.runCalibration = async () => {
      try {
        const cal = await gazeUtils.runCalibrationSequence();
        await gazeUtils.setCalibration(cal);
        return cal;
      } catch (e) { console.warn('Calibration failed', e); return null; }
    };

    // 2) Install a small page-context bridge so page scripts can call async window.sra.runCalibration()
    // The bridge forwards requests via window.postMessage and returns a Promise in page context.
    const bridgeCode = `(function(){
      if (window.__sra_page_bridge_installed) return; window.__sra_page_bridge_installed = true;
      window.__sra_bridge = window.__sra_bridge || { _callbacks: {} };
      window.sra = window.sra || {};
      window.sra.runCalibration = function(){
        return new Promise((resolve, reject) => {
          try {
            const id = Math.random().toString(36).slice(2);
            window.__sra_bridge._callbacks[id] = { resolve, reject };
            window.postMessage({ source: 'sra-page', type: 'runCalibration', id }, '*');
            setTimeout(() => { if (window.__sra_bridge._callbacks[id]) { delete window.__sra_bridge._callbacks[id]; reject(new Error('timeout')); } }, 15000);
          } catch (e) { reject(e); }
        });
      };
      window.addEventListener('message', function(e){
        if (e.source !== window || !e.data || e.data.source !== 'sra-content') return;
        try {
          if (e.data.type === 'calibrationResult' && e.data.id) {
            const cb = window.__sra_bridge._callbacks[e.data.id];
            if (cb) { cb.resolve(e.data.result); delete window.__sra_bridge._callbacks[e.data.id]; }
          }
        } catch (err) { /* ignore */ }
      }, false);
    })();`;

    const pageScript = document.createElement('script');
    pageScript.textContent = bridgeCode;
    (document.head || document.documentElement).appendChild(pageScript);
    pageScript.parentNode && pageScript.parentNode.removeChild(pageScript);

    // 3) Listen for page bridge requests and respond from the content script (safe: content script can call extension APIs)
    window.addEventListener('message', async (event) => {
      if (event.source !== window || !event.data || event.data.source !== 'sra-page') return;
      try {
        if (event.data.type === 'runCalibration' && event.data.id) {
          let result = null;
          try {
            result = await gazeUtils.runCalibrationSequence();
            if (result) await gazeUtils.setCalibration(result);
          } catch (e) { console.warn('Bridge calibration failed', e); }
          window.postMessage({ source: 'sra-content', type: 'calibrationResult', id: event.data.id, result }, '*');
        }
      } catch (e) { /* ignore */ }
    }, false);
  } catch (e) { /* ignore in restricted pages */ }

  // settings + calibration listener
  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'settings') {
      if (typeof msg.eye !== 'undefined') eyeTrackingEnabled = !!msg.eye;
      if (typeof msg.selection !== 'undefined') selectionEnabled = !!msg.selection;
      if (msg.backendUrl) backendUrl = msg.backendUrl;
      if (typeof msg.autohide !== 'undefined') autohideEnabled = !!msg.autohide;
      if (typeof msg.autohideTimeout !== 'undefined') autohideTimeoutSec = Number(msg.autohideTimeout) || 12;
      if (typeof msg.pinDefault !== 'undefined') pinDefault = !!msg.pinDefault;
      if (typeof msg.debug !== 'undefined') debugEnabled = !!msg.debug;
      // forward debug setting to page bootstrap (to toggle prediction points)
      try { window.postMessage({ source: 'sra-control', type: 'setPredictionPoints', enabled: !!debugEnabled }, '*'); } catch (e) {}
      sendResponse({ status: 'ok' });
      return;
    }
    if (msg.type === 'runCalibration') {
      // run calibration flow and respond when done. This may be called from the popup via sendMessage.
      (async () => {
        try {
          let result = null;
          if (window.sra && typeof window.sra.runCalibration === 'function') {
            result = await window.sra.runCalibration();
          } else if (gazeUtils && typeof gazeUtils.runCalibrationSequence === 'function') {
            result = await gazeUtils.runCalibrationSequence();
            if (result) await gazeUtils.setCalibration(result);
          }
          sendResponse({ status: 'ok', calibration: result });
        } catch (e) {
          console.warn('runCalibration message handler failed', e);
          sendResponse({ status: 'error', error: (e && e.message) || String(e) });
        }
      })();
      // indicate we'll respond asynchronously
      return true;
    }
    if (msg.type === 'debugToggle') {
      try {
        debugEnabled = !!msg.enabled;
        window.postMessage({ source: 'sra-control', type: 'setPredictionPoints', enabled: !!debugEnabled }, '*');
        sendResponse({ status: 'ok' });
      } catch (e) { sendResponse({ status: 'error', error: String(e) }); }
      return true;
    }
    if (msg.type === 'startCamera') {
      // Start/restart the camera and show prediction points
      try {
        // attempt to start/restart the tracker if needed and enable prediction points
        try { await startTracker(); } catch (e) { /* ignore */ }
        window.postMessage({ source: 'sra-control', type: 'setPredictionPoints', enabled: true }, '*');
        sendResponse({ status: 'ok' });
      } catch (e) { sendResponse({ status: 'error', error: String(e) }); }
      return true;
    }
  });

})();
