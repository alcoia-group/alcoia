/*
  content.js — TL;DR Extension Core
  Guard at the very top prevents the SyntaxError when injected twice.
*/

// ── Double-injection guard ─────────────────────────────────────────────────
if (window.__sra_content_loaded) {
  // Already running — just restart the tracker if needed
  if (window.__sra_restart_tracker) window.__sra_restart_tracker();
} else {
  window.__sra_content_loaded = true;
  __sra_main();
}

function __sra_main() {

const _log  = (...a) => console.log('[TL;DR]', ...a);
const _warn = (...a) => console.warn('[TL;DR]', ...a);

(async function () {

  // ── Constants ──────────────────────────────────────────────────────────
  const BACKEND_DEFAULT     = 'http://localhost:3000/api/summarize';
  const MIN_SELECTION_CHARS = 15;
  const CLASSIFY_INTERVAL   = 2500;
  const ACTION_COOLDOWN     = 8000;
  const POPUP_ID            = 'sra-floating-popup';
  const POPUP_MARGIN        = 14;

  // ── Runtime state ──────────────────────────────────────────────────────
  let backendUrl         = BACKEND_DEFAULT;
  let eyeTrackingEnabled = true;
  let selectionEnabled   = true;
  let highlightEnabled   = true;
  let autohideEnabled    = false;
  let autohideTimeoutSec = 12;
  let pinDefault         = false;
  let debugEnabled       = false;
  let lastCogState       = 'focused';
  let lastActionAt       = 0;
  let classifyTimer      = null;
  let currentParagraph   = null;
  let lastHighlighted    = null;
  let pdfHandler         = null;
  let pptxHandler        = null;
  let cameraIsReady      = false;

  // Expose restart hook for the double-injection guard above
  window.__sra_restart_tracker = () => { window.__sra_tracker_started = false; startTracker(); };

  // ── Module loader ──────────────────────────────────────────────────────
  const loadModule = (p) => import(chrome.runtime.getURL(p));

  // ── Inject overlay CSS ─────────────────────────────────────────────────
  if (!document.querySelector('[data-sra-css]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.dataset.sraCss = '1';
    l.href = chrome.runtime.getURL('src/styles/overlay.css');
    document.head.appendChild(l);
  }

  // ── Load modules ───────────────────────────────────────────────────────
  const gazeUtils    = await loadModule('src/content/gaze-utils.js');
  const overlayUtils = await loadModule('src/content/overlay-utils.js');
  const featModule   = await loadModule('src/content/gaze-features.js');
  const classModule  = await loadModule('src/content/classifier.js');

  const featureExtractor = featModule.createFeatureExtractor({ windowMs: 2500, minPoints: 15 });
  const { classifyGazeState, COGNITIVE_STATE_ACTIONS } = classModule;

  // ── Load settings ──────────────────────────────────────────────────────
  chrome.storage.local.get({
    sra_backend_url: BACKEND_DEFAULT, sra_eye: true, sra_selection: true,
    sra_highlight_para: true, sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false,
  }, (res) => {
    backendUrl         = res.sra_backend_url || BACKEND_DEFAULT;
    eyeTrackingEnabled = res.sra_eye !== false;
    selectionEnabled   = res.sra_selection !== false;
    highlightEnabled   = res.sra_highlight_para !== false;
    autohideEnabled    = !!res.sra_autohide;
    autohideTimeoutSec = res.sra_autohide_timeout || 12;
    pinDefault         = !!res.sra_pin_default;
    debugEnabled       = !!res.sra_debug;
  });

  // ── Utilities ──────────────────────────────────────────────────────────
  const esc   = (s = '') => s.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── Paragraph highlight ────────────────────────────────────────────────
  function highlightElement(el, ms = 5000) {
    if (!highlightEnabled || !el || el === document.body || el === document.documentElement) return;
    clearHighlight();
    el.classList.add('sra-para-highlight');
    lastHighlighted = el;
    setTimeout(clearHighlight, ms);
  }
  function clearHighlight() {
    if (lastHighlighted) { lastHighlighted.classList.remove('sra-para-highlight'); lastHighlighted = null; }
  }

  // ── AI fetch ───────────────────────────────────────────────────────────
  async function fetchSummary(text, mode = 'tldr') {
    try {
      const url = backendUrl || BACKEND_DEFAULT;
      _log(`Fetching ${url} mode=${mode} len=${text.length}`);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 3500), mode }),
      });
      if (!resp.ok) { _warn(`Server ${resp.status}`); return null; }
      const j = await resp.json();
      return j.summary || j.result || null;
    } catch (e) {
      _warn('fetchSummary failed:', e.message);
      return null;
    }
  }

  // ── Popup positioning ──────────────────────────────────────────────────
  function clampToViewport(root, anchorRect) {
    root.style.visibility = 'hidden';
    root.style.display    = 'block';
    const pw = root.offsetWidth  || 360;
    const ph = root.offsetHeight || 150;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m  = POPUP_MARGIN;
    const a  = anchorRect || { left: vw/2-100, right: vw/2+100, top: vh/2-30, bottom: vh/2+30 };

    let left, top;
    if      (a.right  + m + pw <= vw - m) { left = a.right  + m;     top = clamp(a.top,    m, vh - ph - m); }
    else if (a.left   - m - pw >= m)       { left = a.left   - m - pw; top = clamp(a.top,    m, vh - ph - m); }
    else if (a.bottom + m + ph <= vh - m)  { left = clamp(a.left, m, vw - pw - m); top = a.bottom + m; }
    else if (a.top    - m - ph >= m)       { left = clamp(a.left, m, vw - pw - m); top = a.top    - m - ph; }
    else                                   { left = vw - pw - m;  top = m; }

    root.style.left       = clamp(left, m, vw - pw - m) + 'px';
    root.style.top        = clamp(top,  m, vh - ph - m) + 'px';
    root.style.position   = 'fixed';
    root.style.visibility = '';
  }

  // ── Render popup ───────────────────────────────────────────────────────
  function renderPopup(anchorRect, html, meta = {}) {
    let root = document.getElementById(POPUP_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = POPUP_ID; root.className = 'sra-popup';
      document.body.appendChild(root);
    }
    root.classList.remove('show');
    root.style.display = 'none';
    delete root.dataset.pinned;

    const badge = meta.trigger
      ? `<div class="sra-state-badge">${esc(meta.triggerLabel || meta.trigger)}</div>`
      : meta.source === 'selection'
        ? `<div class="sra-state-badge">selected text</div>`
        : '';

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn" id="sra-pin-btn" title="Pin">📌</button>
        <button class="sra-ctrl-btn" id="sra-close-btn" title="Close">✕</button>
      </div>
      <div class="sra-popup-body">${badge}${html}</div>
      <div class="sra-popup-divider"></div>
      <div class="sra-actions">
        <button class="sra-btn sra-btn-primary"  id="sra-explain-btn">Explain More</button>
        <button class="sra-btn sra-btn-secondary" id="sra-note-btn">Save Note</button>
      </div>`;

    root.querySelector('#sra-close-btn').onclick = hidePopup;

    const pinBtn = root.querySelector('#sra-pin-btn');
    if (pinDefault) { root.dataset.pinned = 'true'; pinBtn.classList.add('active'); }
    pinBtn.onclick = () => {
      const p = root.dataset.pinned === 'true';
      root.dataset.pinned = (!p).toString();
      pinBtn.classList.toggle('active', !p);
    };

    const explainBtn = root.querySelector('#sra-explain-btn');
    explainBtn.onclick = async () => {
      explainBtn.disabled = true; explainBtn.textContent = 'Thinking…';
      const s = await fetchSummary(meta.text || '', 'explain_more');
      const body = root.querySelector('.sra-popup-body');
      if (body && s) body.innerHTML = badge + `<div>${esc(s)}</div>`;
      explainBtn.textContent = 'Explain More'; explainBtn.disabled = false;
    };

    const noteBtn = root.querySelector('#sra-note-btn');
    noteBtn.onclick = () => {
      chrome.runtime.sendMessage({ action: 'saveNote', note: { text: meta.text || '', meta } });
      noteBtn.textContent = 'Saved ✓'; noteBtn.disabled = true;
    };

    clampToViewport(root, anchorRect);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('show')));
    clearTimeout(root._hideT);
    if (autohideEnabled && root.dataset.pinned !== 'true')
      root._hideT = setTimeout(hidePopup, Math.max(3, autohideTimeoutSec) * 1000);
  }

  function hidePopup() {
    const root = document.getElementById(POPUP_ID);
    if (!root || root.dataset.pinned === 'true') return;
    root.classList.remove('show');
    setTimeout(() => { if (root) root.style.display = 'none'; }, 220);
  }

  if (!window.__sra_esc_installed) {
    window.__sra_esc_installed = true;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePopup(); });
  }

  // ── Focus nudge ────────────────────────────────────────────────────────
  function showNudge(el) {
    if (!el) return;
    el.classList.add('sra-nudge-highlight');
    setTimeout(() => el.classList.remove('sra-nudge-highlight'), 3500);
  }

  // ── Code detection ─────────────────────────────────────────────────────
  function isLikelyCode(str) {
    const kw = /\b(function|var|let|const|if|else|for|while|return|class|def|import|public|static|=>|async|await)\b/;
    let inCode = false;
    try {
      let node = window.getSelection()?.anchorNode;
      while (node) {
        if (node.nodeType === 1 && (node.nodeName === 'PRE' || node.nodeName === 'CODE')) { inCode = true; break; }
        node = node.parentNode;
      }
    } catch (e) {}
    return inCode || (str.match(/[{};]/g)||[]).length > 2 || (str.match(kw)||[]).length > 1;
  }

  // ── Selection TL;DR ────────────────────────────────────────────────────
  document.addEventListener('mouseup', async (ev) => {
    if (!selectionEnabled) return;
    let selected = '';
    try { selected = window.getSelection()?.toString().trim() || ''; } catch (e) {}
    if (!selected || selected.length < MIN_SELECTION_CHARS) return;

    // Highlight source element
    try {
      const sel = window.getSelection();
      if (sel?.anchorNode) {
        const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        highlightElement(overlayUtils.getBlockAncestor(el) || el, 5000);
      }
    } catch (e) {}

    // Anchor rect
    let anchorRect = null;
    try {
      const sel = window.getSelection();
      if (sel?.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width || r.height) anchorRect = r;
      }
    } catch (e) {}
    if (!anchorRect) anchorRect = { left: ev.clientX, right: ev.clientX+8, top: ev.clientY, bottom: ev.clientY+8 };

    const mode    = isLikelyCode(selected) ? 'explain_code' : 'tldr';
    const summary = await fetchSummary(selected, mode);

    if (!summary) {
      renderPopup(anchorRect,
        `<div class="sra-error">Could not reach the AI backend.<br>
         Is the server running? Run:<br>
         <code style="font-size:11px;font-family:monospace">cd server &amp;&amp; node index.js</code></div>`,
        { text: selected, source: 'selection', mode });
      return;
    }
    renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text: selected, source: 'selection', mode });
  });

  // ── Paragraph finder ───────────────────────────────────────────────────
  async function findParagraphAt(cx, cy) {
    if (pdfHandler?.findParagraphAt)  { const p = await pdfHandler.findParagraphAt(cx,cy);  if(p) return {type:'pdf', data:p}; }
    if (pptxHandler?.findParagraphAt) { const p = await pptxHandler.findParagraphAt(cx,cy); if(p) return {type:'pptx',data:p}; }
    const el = document.elementFromPoint(cx, cy);
    if (!el) return null;
    return { type: 'dom', data: overlayUtils.getBlockAncestor(el) || el };
  }

  // ── Gaze-triggered AI ──────────────────────────────────────────────────
  async function triggerAIForParagraph(paraInfo, reason) {
    if (!paraInfo) return;
    let text = '', el = null;
    if (paraInfo.type === 'dom') { el = paraInfo.data; text = (el?.innerText || el?.textContent || '').trim(); }
    else if (paraInfo.type === 'pdf')  text = await pdfHandler.getParagraphText(paraInfo.data);
    else if (paraInfo.type === 'pptx') text = await pptxHandler.getParagraphText(paraInfo.data);
    if (!text || text.length < 25) return;

    const mode = reason === 'overloaded' ? 'simplify' : reason === 'confused' ? 'explain_more' : 'tldr';
    const triggerLabel = { confused:'— confused', overloaded:'— overloaded', zoning_out:'— zoning out' }[reason] || reason;

    if (el) highlightElement(el, 6000);
    let anchorRect = null;
    try { if (el) anchorRect = el.getBoundingClientRect(); } catch (e) {}

    const summary = await fetchSummary(text, mode);
    if (!summary) return;
    renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text, source:'gaze', trigger:reason, triggerLabel });
  }

  // ── Gaze processing ────────────────────────────────────────────────────
  const gazeState = gazeUtils.createGazeState({ smoothingAlpha:0.18, dropoutFrames:3, velocityThreshold:1200 });
  let consecutiveNull = 0, lastGazePt = null;

  async function onGaze(data) {
    if (!eyeTrackingEnabled) return;
    if (!data) { consecutiveNull++; if (consecutiveNull >= gazeState.dropoutFrames) lastGazePt = null; return; }
    consecutiveNull = 0;
    const pt = gazeUtils.normalizeAndSmooth(data, gazeState);
    if (!pt) return;
    pt.x = clamp(pt.x, 0, window.innerWidth  - 1);
    pt.y = clamp(pt.y, 0, window.innerHeight - 1);
    if (!gazeUtils.checkVelocity(gazeState, pt)) return;
    lastGazePt = pt;
    featureExtractor.addPoint(pt);
    try { const f = await findParagraphAt(pt.x, pt.y); if (f) currentParagraph = f; } catch (e) {}
  }

  // ── Classification loop ────────────────────────────────────────────────
  function startClassificationLoop() {
    if (classifyTimer) clearInterval(classifyTimer);
    _log('Classification loop started');
    classifyTimer = setInterval(async () => {
      if (!eyeTrackingEnabled || !lastGazePt) return;
      const features = featureExtractor.computeFeatures();
      if (!features) return;
      const { label, confidence } = classifyGazeState(features);
      lastCogState = label;
      // Store so popup can read it
      chrome.storage.local.set({ sra_current_state: label });
      if (debugEnabled) _log(`State: ${label} (${(confidence*100).toFixed(0)}%)`);
      const action = COGNITIVE_STATE_ACTIONS[label];
      const now    = Date.now();
      if (action === 'none' || now - lastActionAt < ACTION_COOLDOWN) return;
      lastActionAt = now;
      if (action === 'explain' || action === 'simplify') await triggerAIForParagraph(currentParagraph, label);
      else if (action === 'nudge') { const el = currentParagraph?.type==='dom'?currentParagraph.data:null; showNudge(el); if(el) highlightElement(el,3000); }
    }, CLASSIFY_INTERVAL);
  }

  // ── WebGazer bootstrap ─────────────────────────────────────────────────
  // CSP-safe: URL passed via data attribute, no inline scripts
  async function startTracker() {
    if (window.__sra_tracker_started) return;
    window.__sra_tracker_started = true;

    try {
      const script = document.createElement('script');
      script.dataset.webgazerUrl = chrome.runtime.getURL('src/libs/webgazer.min.js');
      script.src = chrome.runtime.getURL('src/content/webgazer-bootstrap.js');
      (document.head || document.documentElement).appendChild(script);

      // Fallback injection if bootstrap doesn't fire cameraReady or cameraError within 8s
      let gotSignal = false;
      const fallback = setTimeout(() => {
        if (gotSignal) return;
        _warn('No signal from WebGazer after 8s — trying background injection…');
        chrome.runtime.sendMessage({ action: 'injectWebgazerBootstrap' }, r => {
          if (chrome.runtime.lastError) _warn(chrome.runtime.lastError.message);
        });
      }, 8000);

      window.addEventListener('message', async (ev) => {
        if (ev.source !== window || !ev.data) return;
        const d = ev.data;

        if (d.source === 'sra-webgazer') {
          try { if (d.gaze) onGaze(d.gaze); } catch (e) {}
          return;
        }

        if (d.source === 'sra-control' && d.type === 'cameraReady') {
          gotSignal = true;
          clearTimeout(fallback);
          cameraIsReady = true;
          chrome.storage.local.set({ sra_camera_ready: true });
          _log('WebGazer camera ready ✓');

          setTimeout(async () => {
            try {
              const cal = await gazeUtils.runCalibrationSequence();
              if (cal) await gazeUtils.setCalibration(cal);
              _log('Calibration complete:', cal);
            } catch (e) {
              _warn('Calibration failed (non-fatal):', e.message);
            }
            startClassificationLoop();
          }, 800);
        }

        if (d.source === 'sra-control' && d.type === 'cameraError') {
          gotSignal = true;
          clearTimeout(fallback);
          chrome.storage.local.set({ sra_camera_ready: false, sra_camera_error: d.error || 'unknown' });
          _warn('WebGazer error:', d.error);
          // Still start classification loop — it'll run without gaze data (no action will fire since lastGazePt stays null)
        }
      }, false);
    } catch (e) { _warn('startTracker failed:', e); }
  }

  document.addEventListener('click', e => {
    try { if (window.webgazer) webgazer.recordScreenPosition(e.clientX, e.clientY, 'click'); } catch (e) {}
  });

  // ── PDF/PPTX handlers ─────────────────────────────────────────────────
  async function detectAndInitHandlers() {
    const url = window.location.href;
    if (/\.pdf($|[?#])/i.test(url) || document.querySelector('embed[type="application/pdf"]')) {
      try { const m = await loadModule('src/content/pdf-handler.js'); pdfHandler = await m.initPDFHandler({backendUrl,fetchSummary,renderPopup}); } catch(e) {_warn('PDF:',e);}
    }
    if (/\.pptx($|[?#])/i.test(url) || document.querySelector('a[href$=".pptx"]')) {
      try { const m = await loadModule('src/content/pptx-handler.js'); pptxHandler = await m.initPPTXHandler({backendUrl,fetchSummary,renderPopup}); } catch(e) {_warn('PPTX:',e);}
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.sra = window.sra || {};
  window.sra.runCalibration = async () => {
    const cal = await gazeUtils.runCalibrationSequence();
    if (cal) await gazeUtils.setCalibration(cal);
    return cal;
  };
  window.sra.getState = () => lastCogState;
  window.sra.isCameraReady = () => cameraIsReady;

  // ── Message listener ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(async (msg, _, sendResponse) => {
    if (!msg?.type) return;

    if (msg.type === 'settings') {
      if (msg.eye           !== undefined) eyeTrackingEnabled = !!msg.eye;
      if (msg.selection     !== undefined) selectionEnabled   = !!msg.selection;
      if (msg.highlightPara !== undefined) highlightEnabled   = !!msg.highlightPara;
      if (msg.autohide      !== undefined) autohideEnabled    = !!msg.autohide;
      if (msg.autohideTimeout !== undefined) autohideTimeoutSec = Number(msg.autohideTimeout) || 12;
      if (msg.pinDefault    !== undefined) pinDefault         = !!msg.pinDefault;
      if (msg.debug         !== undefined) debugEnabled       = !!msg.debug;
      if (msg.backendUrl)                  backendUrl         = msg.backendUrl;
      try { window.postMessage({ source:'sra-control', type:'setPredictionPoints', enabled:!!debugEnabled },'*'); } catch(e){}
      sendResponse({ status: 'ok' }); return;
    }
    if (msg.type === 'runCalibration') {
      (async () => {
        try { const cal = await gazeUtils.runCalibrationSequence(); if(cal) await gazeUtils.setCalibration(cal); sendResponse({status:'ok',calibration:cal}); }
        catch (e) { sendResponse({status:'error',error:String(e)}); }
      })(); return true;
    }
    if (msg.type === 'debugToggle') {
      debugEnabled = !!msg.enabled;
      try { window.postMessage({source:'sra-control',type:'setPredictionPoints',enabled:debugEnabled},'*'); } catch(e){}
      sendResponse({ status:'ok' }); return true;
    }
    if (msg.type === 'startCamera') {
      window.__sra_tracker_started = false;
      try { await startTracker(); sendResponse({status:'ok'}); }
      catch (e) { sendResponse({status:'error',error:String(e)}); }
      return true;
    }
    if (msg.type === 'getState') {
      sendResponse({ state: lastCogState, cameraReady: cameraIsReady });
      return;
    }
  });

  // ── Boot ───────────────────────────────────────────────────────────────
  await detectAndInitHandlers();
  await startTracker();
  _log('Content script loaded ✓');

})();
} // end __sra_main