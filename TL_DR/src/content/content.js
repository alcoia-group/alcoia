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
  const CLASSIFY_INTERVAL   = 3000;  // classify every 3s — slightly less CPU, still responsive
  const ACTION_COOLDOWN     = 20000;  // 20s between triggers — prevents feeling too aggressive
  const POPUP_MARGIN        = 14;
  const MAX_POPUPS          = 5;   // hard cap before oldest unpinned is evicted
  // All currently open floating popups — keyed by paragraph fingerprint
  const openPopups          = new Map();
  // Fingerprints of paragraphs currently awaiting an AI response (race-condition guard)
  const inFlightFingerprints = new Set();
  // Session-level cache: mode:fingerprint → summary text (cleared on page unload)
  const _summaryCache        = new Map();

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
  let lastActionAt       = 0;           // global fallback
  const paraActionAt     = new Map();   // per-paragraph cooldown: fingerprint -> timestamp
  let classifyTimer      = null;
  let currentParagraph   = null;
  let lastHighlighted    = null;
  let pdfHandler         = null;
  let pptxHandler        = null;
  let cameraIsReady      = false;
  let idleBlinkEnabled          = true;
  let comprehensionCheckEnabled = true;
  let lastGazeReceivedAt = Date.now();  // tracks when we last got a real gaze point

  // ── New feature flags ──────────────────────────────────────────────────
  let ttsEnabled          = false;
  let focusRulerEnabled   = false;
  let darkModeEnabled     = false;
  let dyslexiaEnabled     = false;
  let dyslexiaColor       = 'rgba(255,243,180,0.12)';
  let bionicEnabled       = false;
  let personalBaseline    = null;  // from calibration or chrome.storage
  let prevParagraphText   = '';    // for AI context window

  // ── Gaze quality tracking ──────────────────────────────────────────────
  let lowQualityStreak    = 0;
  let lastQualityWarnAt   = 0;

  // ── Highlight persistence ──────────────────────────────────────────────
  function saveHighlight(text, summary, state) {
    if (!text || !summary) return;
    const urlKey = window.location.hostname + window.location.pathname;
    const fp = text.slice(0, 80).trim();
    chrome.storage.local.get({ sra_highlights: {} }, ({ sra_highlights: hl }) => {
      if (!hl[urlKey]) hl[urlKey] = [];
      if (!hl[urlKey].find(h => h.fingerprint === fp)) {
        hl[urlKey].unshift({ fingerprint: fp, text: text.slice(0, 300), summary: summary.slice(0, 300), state, timestamp: Date.now(), url: window.location.href, title: document.title });
        if (hl[urlKey].length > 50) hl[urlKey].length = 50;
        chrome.storage.local.set({ sra_highlights: hl });
      }
    });
  }

  function restoreHighlightMarkers() {
    const urlKey = window.location.hostname + window.location.pathname;
    chrome.storage.local.get({ sra_highlights: {} }, ({ sra_highlights: hl }) => {
      const saved = hl[urlKey] || [];
      if (!saved.length) return;
      const fps = new Set(saved.map(h => h.fingerprint));
      document.querySelectorAll('p, li, blockquote, article, section').forEach(el => {
        const fp = (el.innerText || el.textContent || '').trim().slice(0, 80);
        if (fps.has(fp)) el.dataset.sraSummarized = '1';
      });
      if (!document.getElementById('sra-hl-marker-css')) {
        const s = document.createElement('style');
        s.id = 'sra-hl-marker-css';
        s.textContent = '[data-sra-summarized]{border-left:2px solid rgba(26,126,93,0.3)!important;padding-left:6px!important;}';
        document.head.appendChild(s);
      }
    });
  }

  // ── Text-highlight colors ──────────────────────────────────────────────
  const HIGHLIGHT_COLORS = [
    { key: 'yellow', bg: '#FFF59D', label: 'Yellow' },
    { key: 'green',  bg: '#A5D6A7', label: 'Green'  },
    { key: 'blue',   bg: '#90CAF9', label: 'Blue'   },
    { key: 'pink',   bg: '#F48FB1', label: 'Pink'   },
    { key: 'orange', bg: '#FFCC80', label: 'Orange' },
  ];

  // ── State smoothing ring buffer ────────────────────────────────────────
  const STATE_HISTORY     = [];
  const STATE_HISTORY_MAX = 3;

  function getSmoothedState(newLabel) {
    STATE_HISTORY.push(newLabel);
    if (STATE_HISTORY.length > STATE_HISTORY_MAX) STATE_HISTORY.shift();
    const counts = {};
    for (const s of STATE_HISTORY) counts[s] = (counts[s] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // Expose restart hook for the double-injection guard above
  window.__sra_restart_tracker = () => { window.__sra_tracker_started = false; startTracker(); };

  // ── Module loader ──────────────────────────────────────────────────────
  const loadModule = (p) => import(chrome.runtime.getURL(p));

  // ── Inject overlay CSS + Fraunces font ────────────────────────────────
  if (!document.querySelector('[data-sra-css]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.dataset.sraCss = '1';
    l.href = chrome.runtime.getURL('src/styles/overlay.css');
    document.head.appendChild(l);
  }
  if (!document.querySelector('[data-sra-font]')) {
    const f = document.createElement('link');
    f.rel = 'stylesheet'; f.dataset.sraFont = '1';
    f.href = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,700;1,9..144,300;1,9..144,400&display=swap';
    document.head.appendChild(f);
  }

  // ── Load modules ───────────────────────────────────────────────────────
  const gazeUtils    = await loadModule('src/content/gaze-utils.js');
  const overlayUtils = await loadModule('src/content/overlay-utils.js');
  const featModule   = await loadModule('src/content/gaze-features.js');
  const idleModule   = await loadModule('src/content/idle-overlay.js');
  const { updateIdleState, forceStopIdle } = idleModule;
  const compModule  = await loadModule('src/content/comprehension-monitor.js');
  const readCalModule = await loadModule('src/content/reading-calibration.js');
  const { runReadingCalibration } = readCalModule;
  const ttsModule      = await loadModule('src/content/tts-handler.js');
  const rulerModule    = await loadModule('src/content/focus-ruler.js');
  const dyslexiaModule = await loadModule('src/content/dyslexia-utils.js');
  const mapModule      = await loadModule('src/content/reading-map.js');

  const ttsHandler    = ttsModule.createTTSHandler();
  const focusRuler    = rulerModule.createFocusRuler();
  const dyslexiaUtils = dyslexiaModule;
  const readingMap    = mapModule.createReadingMap();
  const sessionModule  = await loadModule('src/content/session-tracker.js');
  const sessionTracker = sessionModule.createSessionTracker();
const comprehensionMonitor = compModule.createComprehensionMonitor({
  speedRatio:     0.30,
  minWords:       70,
  minDifficulty:  58,
  backtrackWindow:4000,
  cooldown:       30000,
});
  const classModule  = await loadModule('src/content/classifier.js');

  const featureExtractor = featModule.createFeatureExtractor({ windowMs: 2500, minPoints: 15 });
  const { classifyGazeState, COGNITIVE_STATE_ACTIONS } = classModule;

  // ── Load settings ──────────────────────────────────────────────────────
  chrome.storage.local.get({
    sra_backend_url: BACKEND_DEFAULT, sra_eye: true, sra_selection: true,
    sra_highlight_para: true, sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_idle_blink: true, sra_comprehension: true,
    sra_tts: false, sra_focus_ruler: false, sra_dyslexia: false,
    sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
    sra_personal_baseline: null, sra_baseline_wpm: null, sra_dark_mode: false,
  }, (res) => {
    backendUrl         = res.sra_backend_url || BACKEND_DEFAULT;
    eyeTrackingEnabled = res.sra_eye !== false;
    selectionEnabled   = res.sra_selection !== false;
    highlightEnabled   = res.sra_highlight_para !== false;
    autohideEnabled    = !!res.sra_autohide;
    autohideTimeoutSec = res.sra_autohide_timeout || 12;
    pinDefault         = !!res.sra_pin_default;
    debugEnabled              = !!res.sra_debug;
    comprehensionCheckEnabled = res.sra_comprehension !== false;
    ttsEnabled        = !!res.sra_tts;
    focusRulerEnabled = !!res.sra_focus_ruler;
    dyslexiaEnabled   = !!res.sra_dyslexia;
    dyslexiaColor     = res.sra_dyslexia_color || 'rgba(255,243,180,0.12)';
    bionicEnabled     = !!res.sra_bionic;
    personalBaseline  = res.sra_personal_baseline || null;
    if (res.sra_baseline_wpm) comprehensionMonitor.seedWpmFromCalibration(res.sra_baseline_wpm);
    if (dyslexiaEnabled) dyslexiaUtils.applyDyslexiaCSS(dyslexiaColor);
    if (focusRulerEnabled) focusRuler.enable();
    darkModeEnabled = !!res.sra_dark_mode;
    if (darkModeEnabled) applyDarkMode(true);
  });

  // ── Utilities ──────────────────────────────────────────────────────────
  const esc   = (s = '') => s.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── Dark mode (in-page overlays) ───────────────────────────────────────
  function applyDarkMode(enabled) {
    const ID = 'sra-dark-styles';
    if (!enabled) { document.getElementById(ID)?.remove(); return; }
    if (document.getElementById(ID)) return;
    const s = document.createElement('style');
    s.id = ID;
    s.textContent = `
      .sra-popup { background: rgba(22,26,24,0.97) !important; color: #e2e2dc !important; border-color: rgba(80,160,120,0.18) !important; box-shadow: 0 8px 28px rgba(0,0,0,0.45) !important; }
      .sra-popup .sra-state-badge { background: rgba(80,160,120,0.1) !important; color: #7dd3b0 !important; border-color: rgba(80,160,120,0.25) !important; }
      .sra-popup .sra-popup-body { color: #e2e2dc !important; }
      .sra-popup .sra-btn-primary  { background: #2a9e6e !important; }
      .sra-popup .sra-btn-secondary{ background: #2563a8 !important; }
      .sra-popup .sra-ctrl-btn     { color: #666 !important; }
      .sra-popup-divider { background: rgba(80,160,120,0.12) !important; }
      .sra-page-summary-panel  { background: #1a1e1c !important; color: #e2e2dc !important; }
      .sra-page-summary-panel h2 { color: #7dd3b0 !important; }
      .sra-page-summary-panel .sra-ps-close { color: #555 !important; }
      .sra-page-summary-panel .sra-ps-close:hover { color: #aaa !important; }
      .sra-page-summary-body strong { color: #7dd3b0 !important; }
      #sra-reading-map { background: rgba(18,22,20,0.97) !important; border-color: rgba(80,160,120,0.12) !important; }
      .sra-map-header  { color: #7a7a72 !important; border-color: rgba(80,160,120,0.1) !important; }
      .sra-map-heading { color: #b8b8b2 !important; }
      .sra-map-heading:hover   { background: rgba(80,160,120,0.07) !important; }
      .sra-map-heading.current { color: #7dd3b0 !important; border-left-color: #7dd3b0 !important; }
      .sra-map-event       { color: #888 !important; }
      .sra-map-events-label{ color: #555 !important; }
      .sra-map-divider     { background: rgba(80,160,120,0.1) !important; }
      .sra-map-progress-bar{ background: rgba(80,160,120,0.12) !important; }
      #sra-color-picker { background: #1e2422 !important; border-color: rgba(255,255,255,0.08) !important; }
    `;
    document.head.appendChild(s);
  }

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
  async function fetchSummary(text, mode = 'tldr', context = '') {
    // Cache hit: serve instantly for repeated requests within the same session.
    // page_summary is excluded — it depends on the full live page content.
    if (mode !== 'page_summary') {
      const cacheKey = `${mode}:${text.slice(0, 80).trim()}`;
      if (_summaryCache.has(cacheKey)) {
        _log(`Cache hit: ${mode}`);
        return _summaryCache.get(cacheKey);
      }
    }
    try {
      const url = backendUrl || BACKEND_DEFAULT;
      _log(`Fetching ${url} mode=${mode} len=${text.length}`);
      const body = { text: text.slice(0, 3500), mode };
      if (context) body.context = context.slice(0, 800);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) { _warn(`Server ${resp.status}`); return null; }
      const j = await resp.json();
      const result = j.summary || j.result || null;
      if (result && mode !== 'page_summary') {
        const cacheKey = `${mode}:${text.slice(0, 80).trim()}`;
        _summaryCache.set(cacheKey, result);
        // Keep cache size bounded — drop oldest entry when over 100
        if (_summaryCache.size > 100) _summaryCache.delete(_summaryCache.keys().next().value);
      }
      return result;
    } catch (e) {
      _warn('fetchSummary failed:', e.message);
      return null;
    }
  }

  // ── Popup positioning ──────────────────────────────────────────────────
  function placePopup(root, anchorRect, avoidRects) {
    root.style.visibility = 'hidden';
    root.style.display    = 'block';
    const pw = root.offsetWidth  || 360;
    const ph = root.offsetHeight || 150;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m  = POPUP_MARGIN;
    const a  = anchorRect || { left: vw/2-100, right: vw/2+100, top: vh/2-30, bottom: vh/2+30 };
    const av = avoidRects || [];

    function overlaps(cx, cy) {
      return av.some(r =>
        cx < r.right + m && cx + pw > r.left - m &&
        cy < r.bottom + m && cy + ph > r.top - m
      );
    }

    // Shift a candidate down past any blocking popup, up to 6 attempts
    function settle(left, top) {
      for (let i = 0; i < 6; i++) {
        if (!overlaps(left, top)) return { left, top };
        const blocker = av.find(r =>
          left < r.right + m && left + pw > r.left - m &&
          top  < r.bottom + m && top  + ph > r.top - m
        );
        if (!blocker || blocker.bottom + m + ph > vh - m) return null;
        top = blocker.bottom + m;
      }
      return null;
    }

    const candidates = [];
    if (a.right  + m + pw <= vw - m)  candidates.push({ left: a.right + m,      top: clamp(a.top, m, vh - ph - m) });
    if (a.left   - m - pw >= m)        candidates.push({ left: a.left - m - pw,   top: clamp(a.top, m, vh - ph - m) });
    if (a.bottom + m + ph <= vh - m)   candidates.push({ left: clamp(a.left, m, vw - pw - m), top: a.bottom + m });
    if (a.top    - m - ph >= m)        candidates.push({ left: clamp(a.left, m, vw - pw - m), top: a.top - m - ph });

    let chosen = null;
    for (const c of candidates) {
      chosen = settle(c.left, c.top);
      if (chosen) break;
    }
    if (!chosen) chosen = { left: vw - pw - m, top: m };

    root.style.left       = clamp(chosen.left, m, vw - pw - m) + 'px';
    root.style.top        = clamp(chosen.top,  m, vh - ph - m) + 'px';
    root.style.position   = 'fixed';
    root.style.visibility = '';
  }

  function closePopup(el, fingerprint) {
    if (fingerprint) openPopups.delete(fingerprint);
    clearTimeout(el._hideT);
    el.classList.remove('show');
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 250);
  }

  function flashPopup(el) {
    const orig = el.style.boxShadow;
    el.style.transition = 'box-shadow 0.12s';
    el.style.boxShadow  = '0 0 0 3px rgba(26,126,93,0.65)';
    setTimeout(() => { el.style.boxShadow = orig; }, 500);
  }

  // ── Render popup (multi-popup: each paragraph gets its own card) ────────
  function renderPopup(anchorRect, html, meta = {}) {
    // Fix: no text → no dedup key and no meaningful content; bail immediately
    if (!meta.text || !meta.text.trim()) return;

    const fingerprint = meta.text.slice(0, 80).trim();

    // Dedup: same paragraph already has a visible popup — just flash it
    if (openPopups.has(fingerprint)) {
      const entry = openPopups.get(fingerprint);
      if (entry.el && document.contains(entry.el)) { flashPopup(entry.el); return; }
      openPopups.delete(fingerprint);
    }

    // Fix: enforce MAX_POPUPS cap — evict the oldest unpinned popup first
    if (openPopups.size >= MAX_POPUPS) {
      for (const [fp, { el }] of openPopups.entries()) {
        if (!el || !document.contains(el)) { openPopups.delete(fp); break; }
        if (el.dataset.pinned !== 'true') { closePopup(el, fp); break; }
      }
      // If every open popup is pinned and we're at the cap, don't create another
      if (openPopups.size >= MAX_POPUPS) return;
    }

    const root = document.createElement('div');
    root.className = 'sra-popup';
    document.body.appendChild(root);
    openPopups.set(fingerprint, { el: root });

    const badge = meta.trigger
      ? `<div class="sra-state-badge">${esc(meta.triggerLabel || meta.trigger)}</div>`
      : meta.source === 'selection'
        ? `<div class="sra-state-badge">selected text</div>`
        : '';

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn sra-pin-btn" title="Pin">📌</button>
        <button class="sra-ctrl-btn sra-close-btn" title="Close">✕</button>
      </div>
      <div class="sra-popup-body">${badge}${html}</div>
      <div class="sra-popup-divider"></div>
      <div class="sra-actions">
        <button class="sra-btn sra-btn-primary  sra-explain-btn">Explain More</button>
        <button class="sra-btn sra-btn-secondary sra-note-btn">Save Note</button>
      </div>`;

    root.querySelector('.sra-close-btn').onclick = () => closePopup(root, fingerprint);

    const pinBtn = root.querySelector('.sra-pin-btn');
    if (pinDefault) { root.dataset.pinned = 'true'; pinBtn.classList.add('active'); }
    pinBtn.onclick = () => {
      const pinned = root.dataset.pinned !== 'true';
      root.dataset.pinned = pinned.toString();
      pinBtn.classList.toggle('active', pinned);
      clearTimeout(root._hideT);
      if (!pinned) {
        // Fix: unpin always starts a countdown — autohide time if enabled, else a
        // generous 60 s fallback so forgotten unpinned cards don't accumulate forever
        const secs = autohideEnabled ? Math.max(3, autohideTimeoutSec) : 60;
        root._hideT = setTimeout(() => closePopup(root, fingerprint), secs * 1000);
      }
    };

    root.querySelector('.sra-explain-btn').onclick = async () => {
      const btn = root.querySelector('.sra-explain-btn');
      btn.disabled = true; btn.textContent = 'Thinking…';
      const s = await fetchSummary(meta.text || '', 'explain_more');
      const body = root.querySelector('.sra-popup-body');
      if (body && s) body.innerHTML = badge + `<div>${esc(s)}</div>`;
      btn.textContent = 'Explain More'; btn.disabled = false;
      // Fix: reset the autohide timer so the user has time to read the expanded content
      clearTimeout(root._hideT);
      if (autohideEnabled && root.dataset.pinned !== 'true')
        root._hideT = setTimeout(() => closePopup(root, fingerprint), Math.max(3, autohideTimeoutSec) * 1000);
    };

    root.querySelector('.sra-note-btn').onclick = () => {
      chrome.runtime.sendMessage({ action: 'saveNote', note: { text: meta.text || '', meta } });
      const btn = root.querySelector('.sra-note-btn');
      btn.textContent = 'Saved ✓'; btn.disabled = true;
    };

    const avoidRects = [...openPopups.values()]
      .filter(e => e.el !== root && document.contains(e.el) && e.el.classList.contains('show'))
      .map(e => e.el.getBoundingClientRect());

    placePopup(root, anchorRect, avoidRects);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('show')));

    clearTimeout(root._hideT);
    if (autohideEnabled && root.dataset.pinned !== 'true')
      root._hideT = setTimeout(() => closePopup(root, fingerprint), Math.max(3, autohideTimeoutSec) * 1000);
  }

  // Close all unpinned popups (Esc)
  function hidePopup() {
    for (const [fp, { el }] of [...openPopups.entries()]) {
      if (!el || !document.contains(el)) { openPopups.delete(fp); continue; }
      if (el.dataset.pinned !== 'true') closePopup(el, fp);
    }
  }

  if (!window.__sra_esc_installed) {
    window.__sra_esc_installed = true;

    document.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { hidePopup(); return; }
      if (!e.altKey) return;

      // Alt+1–5: simulate cognitive states for testing
      const stateMap = { '1': 'confused', '2': 'overloaded', '3': 'zoning_out', '4': 'skimming', '5': 'focused' };
      const simState = stateMap[e.key];
      if (simState) {
        e.preventDefault();
        showSimulateToast(simState);
        lastActionAt = 0;
        lastCogState = simState;
        chrome.storage.local.set({ sra_current_state: simState });
        const action = COGNITIVE_STATE_ACTIONS[simState];
        if (action === 'explain' || action === 'simplify') {
          const para = await findParagraphAt(window.innerWidth / 2, window.innerHeight / 2);
          if (para) { currentParagraph = para; await triggerAIForParagraph(para, simState); }
        } else if (action === 'nudge') {
          const el = currentParagraph?.type === 'dom' ? currentParagraph.data : null;
          showNudge(el); if (el) highlightElement(el, 3000);
        }
        return;
      }

      // Alt+S: summarise paragraph at current gaze / viewport centre
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        const para = await findParagraphAt(window.innerWidth / 2, window.innerHeight / 2);
        if (para) { currentParagraph = para; lastActionAt = 0; await triggerAIForParagraph(para, 'manual'); }
        return;
      }

      // Alt+T: toggle TTS read-aloud
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        ttsEnabled = !ttsEnabled;
        chrome.storage.local.set({ sra_tts: ttsEnabled });
        showSimulateToast(ttsEnabled ? '🔊 Read Aloud on  (Alt+T)' : '🔇 Read Aloud off (Alt+T)');
        return;
      }

      // Alt+F: toggle focus ruler
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        focusRulerEnabled = !focusRulerEnabled;
        focusRulerEnabled ? focusRuler.enable() : focusRuler.disable();
        chrome.storage.local.set({ sra_focus_ruler: focusRulerEnabled });
        showSimulateToast(focusRulerEnabled ? '👁 Focus Ruler on  (Alt+F)' : '👁 Focus Ruler off (Alt+F)');
        return;
      }

      // Alt+N: open notes page
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        chrome.runtime.sendMessage({ action: 'openTab', url: chrome.runtime.getURL('src/popup/notes.html') });
        return;
      }

      // Alt+G: open session report page
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        chrome.runtime.sendMessage({ action: 'openTab', url: chrome.runtime.getURL('src/popup/session-report.html') });
        return;
      }

      // Alt+M: toggle reading map sidebar
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        readingMap.toggle();
        return;
      }
    });
  }

  // ── Simulate toast — small on-screen indicator ─────────────────────────
  function showSimulateToast(state) {
    const existing = document.getElementById('sra-sim-toast');
    if (existing) existing.remove();

    const labels = {
      confused:   '🤔 Simulating: Confused  (Alt+1)',
      overloaded: '🧠 Simulating: Overloaded (Alt+2)',
      zoning_out: '💤 Simulating: Zoning Out (Alt+3)',
      skimming:   '⚡ Simulating: Skimming   (Alt+4)',
      focused:    '✅ Simulating: Focused    (Alt+5)',
    };

    const toast = document.createElement('div');
    toast.id = 'sra-sim-toast';
    Object.assign(toast.style, {
      position:       'fixed',
      bottom:         '24px',
      left:           '50%',
      transform:      'translateX(-50%)',
      background:     '#1A7E5D',
      color:          'white',
      padding:        '9px 20px',
      borderRadius:   '8px',
      fontFamily:     "'Fraunces', Georgia, serif",
      fontSize:       '13px',
      fontStyle:      'italic',
      zIndex:         '2147483646',
      opacity:        '0',
      transition:     'opacity 0.2s ease',
      pointerEvents:  'none',
      whiteSpace:     'nowrap',
      boxShadow:      '0 4px 16px rgba(0,0,0,0.2)',
    });
    toast.textContent = labels[state] || state;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => { toast.style.opacity = '1'; });
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { try { toast.remove(); } catch(e){} }, 250);
    }, 1800);
  }

  // ── Gaze quality toast ─────────────────────────────────────────────────
  function showQualityToast() {
    const existing = document.getElementById('sra-quality-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'sra-quality-toast';
    Object.assign(toast.style, {
      position:     'fixed', top: '14px', right: '14px',
      background:   '#2c2c2a', color: '#f0ede8',
      padding:      '9px 16px', borderRadius: '9px',
      fontFamily:   "'Fraunces', Georgia, serif", fontSize: '12px',
      zIndex:       '2147483640', opacity: '0',
      transition:   'opacity 0.2s ease', pointerEvents: 'none',
      boxShadow:    '0 4px 14px rgba(0,0,0,0.25)', maxWidth: '240px', lineHeight: '1.5',
    });
    toast.textContent = 'Low camera quality — move to better lighting or centre your face in frame.';
    document.body.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => { toast.style.opacity = '1'; }));
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { try { toast.remove(); } catch(e){} }, 250);
    }, 5000);
  }

  // ── Text highlighting (Ctrl+drag to select) ────────────────────────────
  function showColorPicker(range, clientX, clientY) {
    removeColorPicker();
    const picker = document.createElement('div');
    picker.id = 'sra-color-picker';
    Object.assign(picker.style, {
      position: 'fixed', zIndex: '2147483645',
      left: Math.min(clientX, window.innerWidth - 200) + 'px',
      top:  (clientY + 10) + 'px',
      background: 'white',
      border: '1px solid rgba(0,0,0,0.10)',
      borderRadius: '14px',
      padding: '8px 11px',
      display: 'flex', alignItems: 'center', gap: '7px',
      boxShadow: '0 6px 24px rgba(0,0,0,0.16)',
      fontFamily: "'Fraunces', Georgia, serif",
    });

    const label = document.createElement('span');
    label.textContent = 'Highlight:';
    label.style.cssText = 'font-size:10px;color:#888;font-style:italic;white-space:nowrap;';
    picker.appendChild(label);

    HIGHLIGHT_COLORS.forEach(({ key, bg, label: lbl }) => {
      const sw = document.createElement('button');
      sw.title = lbl;
      Object.assign(sw.style, {
        width: '22px', height: '22px', borderRadius: '50%', background: bg,
        border: '2px solid rgba(0,0,0,0.12)', cursor: 'pointer', flexShrink: '0',
        transition: 'transform 0.12s',
      });
      sw.onmouseenter = () => { sw.style.transform = 'scale(1.2)'; };
      sw.onmouseleave = () => { sw.style.transform = ''; };
      sw.addEventListener('mousedown', e => e.preventDefault()); // keep selection alive
      sw.addEventListener('click', e => {
        e.stopPropagation();
        applyTextHighlight(range, bg, key);
        removeColorPicker();
      });
      picker.appendChild(sw);
    });

    const dismiss = document.createElement('button');
    dismiss.textContent = '×';
    dismiss.style.cssText = 'background:none;border:none;cursor:pointer;color:#bbb;font-size:18px;padding:0 2px;line-height:1;';
    dismiss.addEventListener('click', e => { e.stopPropagation(); removeColorPicker(); });
    picker.appendChild(dismiss);

    document.body.appendChild(picker);
    // Auto-dismiss on next outside click
    setTimeout(() => document.addEventListener('click', removeColorPicker, { once: true }), 10);
  }

  function removeColorPicker() {
    const p = document.getElementById('sra-color-picker');
    if (p) p.remove();
  }

  function applyTextHighlight(range, bgColor, colorKey) {
    if (!range || range.collapsed) return;
    const text = range.toString().trim();
    if (!text || text.length > 2000) return; // guard against Ctrl+A

    const hlId = 'sra-hl-' + Date.now();
    const mark  = document.createElement('mark');
    mark.dataset.sraHlId    = hlId;
    mark.dataset.sraHlColor = colorKey;
    mark.style.cssText = `background:${bgColor};border-radius:3px;padding:0 1px;mix-blend-mode:multiply;cursor:default;`;
    mark.title = 'Double-click to remove highlight';

    try {
      range.surroundContents(mark);
    } catch (_) {
      // Selection crosses element boundaries
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }

    mark.addEventListener('dblclick', () => deleteTextHighlight(hlId, mark));

    // Context for restoration
    const bodyText = document.body.innerText || '';
    const pos = bodyText.indexOf(text);
    const ctxBefore = pos > 0 ? bodyText.slice(Math.max(0, pos - 40), pos).trim() : '';
    const ctxAfter  = pos >= 0 ? bodyText.slice(pos + text.length, pos + text.length + 40).trim() : '';

    const urlKey = window.location.hostname + window.location.pathname;
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: hl }) => {
      if (!hl[urlKey]) hl[urlKey] = [];
      hl[urlKey].push({
        id: hlId, text: text.slice(0, 300), color: bgColor, colorKey,
        ctxBefore, ctxAfter,
        url: window.location.href, title: document.title, timestamp: Date.now(),
      });
      if (hl[urlKey].length > 100) hl[urlKey].shift();
      chrome.storage.local.set({ sra_text_highlights: hl });
    });
  }

  function deleteTextHighlight(hlId, markEl) {
    const parent = markEl.parentNode;
    if (!parent) return;
    while (markEl.firstChild) parent.insertBefore(markEl.firstChild, markEl);
    parent.removeChild(markEl);

    const urlKey = window.location.hostname + window.location.pathname;
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: hl }) => {
      if (hl[urlKey]) {
        hl[urlKey] = hl[urlKey].filter(h => h.id !== hlId);
        chrome.storage.local.set({ sra_text_highlights: hl });
      }
    });
  }

  function restoreTextHighlights() {
    const urlKey = window.location.hostname + window.location.pathname;
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: hl }) => {
      const saved = hl[urlKey] || [];
      if (!saved.length) return;
      saved.forEach(entry => { try { restoreSingleHighlight(entry); } catch (_) {} });
    });
  }

  function restoreSingleHighlight({ id: hlId, text, color, ctxBefore }) {
    if (!text || text.length < 2) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const tag = node.parentElement?.tagName?.toUpperCase?.();
      if (['SCRIPT','STYLE','NOSCRIPT','MARK'].includes(tag)) continue;
      const idx = node.textContent.indexOf(text);
      if (idx === -1) continue;
      // Light context check to avoid wrong match
      const pre = node.textContent.slice(0, idx).trim().slice(-20);
      if (ctxBefore && ctxBefore.length > 4 && !ctxBefore.endsWith(pre.slice(-4)) && !pre.endsWith(ctxBefore.slice(-8))) continue;

      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, Math.min(idx + text.length, node.textContent.length));

      const mark = document.createElement('mark');
      mark.dataset.sraHlId = hlId;
      mark.style.cssText = `background:${color};border-radius:3px;padding:0 1px;mix-blend-mode:multiply;cursor:default;`;
      mark.title = 'Double-click to remove highlight';
      mark.addEventListener('dblclick', () => deleteTextHighlight(hlId, mark));

      try {
        range.surroundContents(mark);
      } catch (_) {
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      }
      return;
    }
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

  // ── Word lookup (Ctrl+hover) ───────────────────────────────────────────
  let _ctrlHeld       = false;
  let _wordBubble     = null;
  let _wordTimer      = null;
  let _lastHoveredWord = null;
  let _imageDwellEl   = null;
  let _imageDwellStart = 0;

  document.addEventListener('keydown', e => { if (e.key === 'Control' || e.key === 'Meta') _ctrlHeld = true; });
  document.addEventListener('keyup',   e => {
    if (e.key === 'Control' || e.key === 'Meta') {
      _ctrlHeld = false;
      clearTimeout(_wordTimer);
      hideWordBubble();
    }
  });

  document.addEventListener('mousemove', e => {
    if (!_ctrlHeld || !selectionEnabled) return;
    clearTimeout(_wordTimer);
    _wordTimer = setTimeout(() => {
      // If hovering over an image, explain it instead of looking up a word
      const topEl = document.elementFromPoint(e.clientX, e.clientY);
      const imgEl = topEl?.tagName === 'IMG' ? topEl : null;
      if (imgEl) {
        const fp = 'img:' + (imgEl.src || '').slice(-60) + ':' + (imgEl.alt || '').slice(0, 20);
        if (fp === _lastHoveredWord) return;
        _lastHoveredWord = fp;
        hideWordBubble();
        triggerImageExplanation(imgEl, e.clientX, e.clientY, 'hover');
        return;
      }
      const hit = getWordAtPoint(e.clientX, e.clientY);
      if (!hit || hit.word === _lastHoveredWord) return;
      _lastHoveredWord = hit.word;
      triggerWordLookup(hit, e.clientX, e.clientY);
    }, 380);
  });

  function getWordAtPoint(x, y) {
    try {
      const range = document.caretRangeFromPoint?.(x, y);
      if (!range || range.startContainer?.nodeType !== Node.TEXT_NODE) return null;
      const node   = range.startContainer;
      const offset = range.startOffset;
      const text   = node.textContent || '';
      let start = offset, end = offset;
      while (start > 0 && /[\w'-]/.test(text[start - 1])) start--;
      while (end < text.length && /[\w'-]/.test(text[end])) end++;
      const word = text.slice(start, end).replace(/[^a-zA-Z'-]/g, '');
      if (!word || word.length < 2 || word.length > 45) return null;
      // Surrounding sentence for context
      const sentStart = Math.max(0, text.lastIndexOf('.', start) + 1);
      const sentEnd   = text.indexOf('.', end);
      const sentence  = text.slice(sentStart, sentEnd > 0 ? sentEnd + 1 : text.length).trim().slice(0, 300)
                        || text.slice(Math.max(0, start - 80), end + 80).trim();
      return { word, sentence };
    } catch (_) { return null; }
  }

  async function triggerWordLookup({ word, sentence }, cx, cy) {
    hideWordBubble();
    const bubble = document.createElement('div');
    bubble.className = 'sra-word-bubble';
    bubble.innerHTML = `<strong>${esc(word)}</strong><span class="sra-word-loading">looking up…</span>`;
    // Initial position near cursor
    bubble.style.left = Math.min(cx + 14, window.innerWidth  - 280) + 'px';
    bubble.style.top  = Math.min(cy + 14, window.innerHeight - 120) + 'px';
    document.body.appendChild(bubble);
    _wordBubble = bubble;
    requestAnimationFrame(() => bubble.classList.add('show'));

    const payload = `word: ${word}\nContext sentence: ${sentence}`;
    const def = await fetchSummary(payload, 'define_word');

    if (!_wordBubble || !document.contains(_wordBubble)) return;
    if (def) {
      bubble.innerHTML = `<strong>${esc(word)}</strong><div>${esc(def)}</div>`;
      // Re-clamp after content change
      const bw = bubble.offsetWidth || 260, bh = bubble.offsetHeight || 80;
      bubble.style.left = clamp(cx + 14, 10, window.innerWidth  - bw - 10) + 'px';
      bubble.style.top  = clamp(cy + 14, 10, window.innerHeight - bh - 10) + 'px';
    } else {
      hideWordBubble();
    }
  }

  function hideWordBubble() {
    if (_wordBubble) { _wordBubble.remove(); _wordBubble = null; }
    _lastHoveredWord = null;
  }

  // ── Image explanation (Ctrl+hover or gaze dwell while confused) ────────
  function getImageContext(imgEl) {
    let el = imgEl.parentElement;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      const sibs = el.parentElement ? [...el.parentElement.children] : [];
      const idx = sibs.indexOf(el);
      for (const sib of [sibs[idx-1], sibs[idx+1], sibs[idx-2], sibs[idx+2]].filter(Boolean)) {
        if (sib.contains(imgEl)) continue;
        const t = (sib.innerText || sib.textContent || '').trim();
        if (t.length > 50) return t.slice(0, 400);
      }
      el = el.parentElement;
    }
    return '';
  }

  async function triggerImageExplanation(imgEl, cx, cy, reason) {
    const fp = 'img:' + (imgEl.src || '').slice(-60) + ':' + (imgEl.alt || '').slice(0, 20);
    if (inFlightFingerprints.has(fp)) return;
    inFlightFingerprints.add(fp);

    const alt        = (imgEl.alt   || '').trim();
    const titleAttr  = (imgEl.title || '').trim();
    const figure     = imgEl.closest('figure');
    const caption    = (figure?.querySelector('figcaption')?.textContent || '').trim();
    const surrounding = getImageContext(imgEl);

    const parts = [];
    if (alt)                    parts.push(`Alt text: "${alt}"`);
    if (titleAttr && titleAttr !== alt) parts.push(`Title: "${titleAttr}"`);
    if (caption)                parts.push(`Caption: "${caption}"`);
    if (surrounding)            parts.push(`Surrounding text:\n"${surrounding}"`);

    if (!parts.length) { inFlightFingerprints.delete(fp); return; }

    const payload = parts.join('\n');
    const anchorRect = imgEl.getBoundingClientRect();

    // Show a small loading bubble immediately so the user knows something is happening
    const bubble = document.createElement('div');
    bubble.className = 'sra-word-bubble';
    bubble.style.cssText = `left:${Math.min(cx + 14, window.innerWidth - 280)}px;top:${Math.min(cy + 14, window.innerHeight - 120)}px;`;
    bubble.innerHTML = '<strong>Image</strong><span class="sra-word-loading">analysing…</span>';
    document.body.appendChild(bubble);
    requestAnimationFrame(() => bubble.classList.add('show'));

    try {
      const summary = await fetchSummary(payload, 'image_context');
      bubble.remove();
      if (summary) {
        const label = reason === 'hover' ? 'image · Ctrl+hover' : `image · ${reason}`;
        renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text: payload, source: 'image', trigger: reason, triggerLabel: label });
      }
    } finally {
      inFlightFingerprints.delete(fp);
    }
  }

  // ── Selection TL;DR (or Ctrl+drag → colour highlight) ──────────────────
  document.addEventListener('mouseup', async (ev) => {
    if (!selectionEnabled) return;

    let selected = '';
    let selRange  = null;
    try {
      const sel = window.getSelection();
      selected  = sel?.toString().trim() || '';
      if (sel?.rangeCount > 0) selRange = sel.getRangeAt(0).cloneRange();
    } catch (e) {}
    if (!selected || selected.length < MIN_SELECTION_CHARS) return;

    // Ctrl/Cmd + drag → colour highlight instead of AI summary
    if (ev.ctrlKey || ev.metaKey) {
      removeColorPicker();
      if (selRange) showColorPicker(selRange, ev.clientX, ev.clientY);
      return;
    }

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
      if (selRange) {
        const r = selRange.getBoundingClientRect();
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
    readingMap.recordEvent('summarized', selected.slice(0, 40));
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

    // Don't spawn a duplicate popup for the same paragraph
    const _fp = text.slice(0, 80).trim();
    if (_fp && openPopups.has(_fp)) {
      const _e = openPopups.get(_fp);
      if (_e.el && document.contains(_e.el)) { flashPopup(_e.el); return; }
      openPopups.delete(_fp);
    }
    // Fix: block concurrent fetches for the same paragraph (race condition guard)
    if (_fp && inFlightFingerprints.has(_fp)) return;
    if (_fp) inFlightFingerprints.add(_fp);

    const mode = reason === 'overloaded' ? 'simplify' : reason === 'confused' ? 'explain_more' : 'tldr';
    const triggerLabel = { confused:'— confused', overloaded:'— overloaded', zoning_out:'— zoning out' }[reason] || reason;

    if (el) {
      highlightElement(el, 6000);
      if (bionicEnabled) dyslexiaUtils.applyBionicReading(el);
    }
    let anchorRect = null;
    try { if (el) anchorRect = el.getBoundingClientRect(); } catch (e) {}

    if (ttsEnabled) ttsHandler.speak(text, { el: el || null });

    try {
      const summary = await fetchSummary(text, mode, prevParagraphText);
      if (!summary) return;
      renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text, source:'gaze', trigger:reason, triggerLabel });
      saveHighlight(text, summary, reason);
      sessionTracker.recordSignal('cognitive', reason, text.slice(0, 150));
      readingMap.recordEvent(reason, text.slice(0, 40));
    } finally {
      if (_fp) inFlightFingerprints.delete(_fp);
    }
  }

  // ── Gaze processing ────────────────────────────────────────────────────
  const gazeState = gazeUtils.createGazeState({ smoothingAlpha:0.35, dropoutFrames:3, velocityThreshold:1800 });
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
    lastGazeReceivedAt = Date.now();
    featureExtractor.addPoint(pt);

    // Image dwell: if gaze stays on the same image while confused/overloaded for >2s, explain it
    const _gazeTopEl = document.elementFromPoint(pt.x, pt.y);
    const _gazeImg   = _gazeTopEl?.tagName === 'IMG' ? _gazeTopEl
      : (_gazeTopEl?.closest?.('figure')?.querySelector?.('img') || null);
    if (_gazeImg) {
      if (_gazeImg !== _imageDwellEl) { _imageDwellEl = _gazeImg; _imageDwellStart = Date.now(); }
      else if (['confused', 'overloaded'].includes(lastCogState) && Date.now() - _imageDwellStart > 2000) {
        const _ifp = 'img:' + (_gazeImg.src || '').slice(-60) + ':' + (_gazeImg.alt || '').slice(0, 20);
        if (!inFlightFingerprints.has(_ifp)) {
          _imageDwellStart = Date.now() + 30000; // suppress for 30s after trigger
          triggerImageExplanation(_gazeImg, pt.x, pt.y, lastCogState);
        }
      }
    } else {
      _imageDwellEl = null;
    }

    // Focus ruler follows gaze Y in real time
    if (focusRulerEnabled) focusRuler.update(pt.y);

    try {
      const f = await findParagraphAt(pt.x, pt.y);
      if (f) {
        const isPopup = f.type === 'dom' && f.data &&
          (f.data.classList?.contains('sra-popup') || !!f.data.closest?.('.sra-popup'));
        if (!isPopup) {
          if (comprehensionCheckEnabled && f.type === 'dom' && f.data !== (currentParagraph && currentParagraph.data)) {
            const signal = comprehensionMonitor.leaveParagraph();
            if (signal) handleComprehensionSignal(signal);
            // Save text of departing paragraph as context for the next AI call
            if (currentParagraph?.type === 'dom' && currentParagraph.data) {
              prevParagraphText = (currentParagraph.data.innerText || currentParagraph.data.textContent || '')
                .trim().slice(0, 800);
            }
            comprehensionMonitor.enterParagraph(f.data);
          }
          currentParagraph = f;
        }
      }
    } catch (e) {}
  }

  // ── Comprehension signal handler ──────────────────────────────────────────
  async function handleComprehensionSignal(signal) {
    if (!comprehensionCheckEnabled) return;

    comprehensionMonitor.markOfferShown();
    sessionTracker.recordSignal(signal.type, signal.subtype || '', signal.text || '');

    const el = (signal.type === 'speed_mismatch') ? signal.el
              : (currentParagraph?.type === 'dom' ? currentParagraph.data : null);

    if (el) highlightElement(el, 4000);

    let text = signal.text || '';
    if (!text && el) text = (el.innerText || el.textContent || '').trim();
    if (!text) return;

    let anchorRect = null;
    try { if (el) anchorRect = el.getBoundingClientRect(); } catch (e) {}

    const fingerprint = 'comp-' + text.slice(0, 80).trim();
    if (openPopups.has(fingerprint)) {
      const entry = openPopups.get(fingerprint);
      if (entry.el && document.contains(entry.el)) { flashPopup(entry.el); return; }
      openPopups.delete(fingerprint);
    }

    const root = document.createElement('div');
    root.className = 'sra-popup';
    document.body.appendChild(root);
    openPopups.set(fingerprint, { el: root });

    const offerHtml = buildComprehensionOfferHtml(signal);

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn sra-close-btn" title="Close">&#x2715;</button>
      </div>
      <div class="sra-popup-body">${offerHtml}</div>
      <div class="sra-popup-divider"></div>
      <div class="sra-actions">
        <button class="sra-btn sra-btn-primary  sra-comp-summarise">Summarise it</button>
        <button class="sra-btn sra-btn-secondary sra-comp-dismiss">I understood it</button>
      </div>`;

    root.querySelector('.sra-close-btn').onclick = () => closePopup(root, fingerprint);
    root.querySelector('.sra-comp-dismiss').onclick = () => closePopup(root, fingerprint);
    root.querySelector('.sra-comp-summarise').onclick = async () => {
      const btn = root.querySelector('.sra-comp-summarise');
      btn.disabled = true; btn.textContent = 'Thinking…';
      const summary = await fetchSummary(text, 'explain_more');
      if (summary) {
        const body = root.querySelector('.sra-popup-body');
        if (body) body.innerHTML = `<div class="sra-state-badge">comprehension assist</div><div>${esc(summary)}</div>`;
        btn.textContent = 'Summarise it'; btn.disabled = false;
        const dismiss = root.querySelector('.sra-comp-dismiss');
        if (dismiss) {
          dismiss.textContent = 'Save Note';
          dismiss.onclick = () => {
            chrome.runtime.sendMessage({ action: 'saveNote', note: { text, meta: { source: 'comprehension', mode: 'explain_more' } } });
            dismiss.textContent = 'Saved ✓'; dismiss.disabled = true;
          };
        }
      }
    };

    const avoidRects = [...openPopups.values()]
      .filter(e => e.el !== root && document.contains(e.el) && e.el.classList.contains('show'))
      .map(e => e.el.getBoundingClientRect());

    placePopup(root, anchorRect, avoidRects);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('show')));

    clearTimeout(root._hideT);
    if (autohideEnabled && root.dataset.pinned !== 'true')
      root._hideT = setTimeout(() => closePopup(root, fingerprint), Math.max(3, autohideTimeoutSec) * 1000);
  }

  function buildComprehensionOfferHtml(signal) {
    if (signal.type === 'speed_mismatch') {
      const r = signal.readability;
      const pct = Math.round(signal.ratio * 100);
      const secActual   = Math.round(signal.elapsed / 1000);
      const secExpected = Math.round(signal.expected / 1000);
      return `<div class="sra-state-badge" style="color:#a06000;border-color:rgba(160,96,0,0.3);background:rgba(160,96,0,0.06)">
        reading pace check</div>
        <div style="line-height:1.7">That was a <strong>complex paragraph</strong>
        (readability score ${r.score.toFixed(0)}/100) but you moved through it
        in ${secActual}s — expected at least ${secExpected}s for text this dense.
        <br><em style="color:var(--muted)">Want a quick summary?</em></div>`;
    }
    if (signal.type === 'backtrack') {
      return `<div class="sra-state-badge" style="color:#5a3e8a;border-color:rgba(90,62,138,0.3);background:rgba(90,62,138,0.06)">
        scroll backtrack</div>
        <div style="line-height:1.7">You scrolled back — looks like something might not have
        landed clearly.<br><em style="color:var(--muted)">Want a summary of what you just passed?</em></div>`;
    }
    return '<div>Want a summary?</div>';
  }

  // ── Classification loop ────────────────────────────────────────────────
  function startClassificationLoop() {
    if (classifyTimer) clearInterval(classifyTimer);
    _log('Classification loop started');
    classifyTimer = setInterval(async () => {
      if (!eyeTrackingEnabled || !lastGazePt) return;
      const rawFeatures = featureExtractor.computeFeatures();
      if (!rawFeatures) return;

      // Quality gate: skip classification when webcam tracking is too noisy
      // (poor lighting, glasses glare, face partially occluded)
      if (rawFeatures.gaze_quality < 0.25) {
        if (debugEnabled) _log(`Skipping classify — low gaze quality (${(rawFeatures.gaze_quality*100).toFixed(0)}%)`);
        lowQualityStreak++;
        if (lowQualityStreak >= 8 && Date.now() - lastQualityWarnAt > 60000) {
          showQualityToast();
          lastQualityWarnAt = Date.now();
        }
        return;
      }
      lowQualityStreak = 0;

      // Normalize features against personal baseline so individual reading
      // styles don't bias the fixed classifier thresholds
      const features = personalBaseline
        ? gazeUtils.normalizeWithBaseline(rawFeatures, personalBaseline)
        : rawFeatures;

      // Apply dyslexia threshold patch before classifying
      const classFeatures = dyslexiaEnabled
        ? dyslexiaUtils.patchFeaturesForDyslexia(features)
        : features;

      const { label, confidence } = classifyGazeState(classFeatures);

      // Smooth over 3 windows to prevent single-sample false triggers
      const smoothedLabel = getSmoothedState(label);
      lastCogState = smoothedLabel;
      chrome.storage.local.set({ sra_current_state: smoothedLabel });
      sessionTracker.recordState(smoothedLabel);
      if (focusRulerEnabled) focusRuler.adaptToState(smoothedLabel);
      if (debugEnabled) _log(`State: ${smoothedLabel} (raw: ${label}, conf: ${(confidence*100).toFixed(0)}%, quality: ${(rawFeatures.gaze_quality*100).toFixed(0)}%)`);
      if (idleBlinkEnabled) updateIdleState(rawFeatures, lastGazePt, lastGazeReceivedAt);
      else forceStopIdle();

      const action = COGNITIVE_STATE_ACTIONS[smoothedLabel];
      const now    = Date.now();
      if (action === 'none') return;

      // Per-paragraph cooldown: each paragraph has its own 8-second window
      const paraKey = currentParagraph && currentParagraph.type === 'dom' && currentParagraph.data
        ? (currentParagraph.data.innerText || '').slice(0, 80).trim()
        : 'global';
      const lastFiredForThisPara = paraActionAt.get(paraKey) || 0;
      if (now - lastFiredForThisPara < ACTION_COOLDOWN) return;

      paraActionAt.set(paraKey, now);
      lastActionAt = now;
      // Clean old entries (keep map small)
      if (paraActionAt.size > 50) {
        const oldest = [...paraActionAt.entries()].sort((a,b)=>a[1]-b[1])[0][0];
        paraActionAt.delete(oldest);
      }
      if (action === 'explain' || action === 'simplify') await triggerAIForParagraph(currentParagraph, smoothedLabel);
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
              // One-time calibration: if user has calibrated before, restore
              // the saved model silently. No overlay, no interruption.
              // Recalibrate anytime via the popup buttons.
              const stored = await new Promise(resolve =>
                chrome.storage.local.get({ sra_ever_calibrated: false }, r => resolve(r))
              );
              if (stored.sra_ever_calibrated) {
                // Calibration offset is already loaded from storage in createGazeState().
                // WebGazer keeps improving from continuous click recording as the user reads.
                _log('Calibration persisted — skipping first-time sequence');
              } else {
                _log('First-time calibration starting...');
                const cal = await gazeUtils.runCalibrationSequence();
                if (cal) {
                  await gazeUtils.setCalibration(cal);
                  chrome.storage.local.set({ sra_ever_calibrated: true });
                  _log('First-time calibration complete and saved');
                }
              }
            } catch (e) {
              _warn('Calibration step failed (non-fatal):', e.message);
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

  // Continuous click recording: every click is a WebGazer training example.
  // This is the correct way — postMessage to the bootstrap in page context,
  // which calls webgazer.recordScreenPosition(). Content scripts can't access
  // window.webgazer directly (isolated world), but postMessage crosses worlds.
  document.addEventListener('click', (e) => {
    try {
      window.postMessage({ source: 'sra-cal-record', x: e.clientX, y: e.clientY }, '*');
    } catch (err) {}
  }, { passive: true, capture: false });

  // Scroll backtrack detection (user scrolls back to re-read = comprehension signal)
  window.addEventListener('scroll', () => {
    if (!comprehensionCheckEnabled) return;
    try {
      const signal = comprehensionMonitor.onScroll();
      if (signal) handleComprehensionSignal(signal);
    } catch (e) {}
  }, { passive: true });

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
      if (msg.eye           !== undefined) {
        eyeTrackingEnabled = !!msg.eye;
        if (!eyeTrackingEnabled) forceStopIdle();
      }
      if (msg.selection     !== undefined) selectionEnabled   = !!msg.selection;
      if (msg.highlightPara !== undefined) highlightEnabled   = !!msg.highlightPara;
      if (msg.autohide      !== undefined) autohideEnabled    = !!msg.autohide;
      if (msg.autohideTimeout !== undefined) autohideTimeoutSec = Number(msg.autohideTimeout) || 12;
      if (msg.pinDefault    !== undefined) pinDefault         = !!msg.pinDefault;
      if (msg.debug         !== undefined) debugEnabled       = !!msg.debug;
      if (msg.idleBlink     !== undefined) { idleBlinkEnabled = !!msg.idleBlink; if (!idleBlinkEnabled) forceStopIdle(); }
      if (msg.comprehension !== undefined) comprehensionCheckEnabled = !!msg.comprehension;
      if (msg.backendUrl)                  backendUrl         = msg.backendUrl;
      // New feature flags
      if (msg.tts           !== undefined) ttsEnabled         = !!msg.tts;
      if (msg.focusRuler    !== undefined) {
        focusRulerEnabled = !!msg.focusRuler;
        focusRulerEnabled ? focusRuler.enable() : focusRuler.disable();
      }
      if (msg.dyslexia      !== undefined || msg.dyslexiaColor !== undefined) {
        if (msg.dyslexia !== undefined) dyslexiaEnabled = !!msg.dyslexia;
        if (msg.dyslexiaColor) dyslexiaColor = msg.dyslexiaColor;
        dyslexiaEnabled
          ? dyslexiaUtils.applyDyslexiaCSS(dyslexiaColor)
          : dyslexiaUtils.removeDyslexiaCSS();
      }
      if (msg.bionic        !== undefined) bionicEnabled = !!msg.bionic;
      if (msg.darkMode      !== undefined) { darkModeEnabled = !!msg.darkMode; applyDarkMode(darkModeEnabled); }
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
    if (msg.type === 'startReadingCalibration') {
      (async () => {
        try {
          // Reset feature extractor so calibration gaze data builds a clean baseline
          featureExtractor.reset();
          const result = await runReadingCalibration({
            msPerWord:  220,
            onComplete: (success, wpm) => {
              _log('Reading calibration complete, success:', success, 'wpm:', wpm);
              if (success && wpm) {
                // Seed comprehension monitor WPM baseline from calibration
                comprehensionMonitor.seedWpmFromCalibration(wpm);
                // Capture gaze feature baseline from what was just recorded
                const baselineFeatures = featureExtractor.computeFeatures();
                if (baselineFeatures) {
                  personalBaseline = baselineFeatures;
                  chrome.storage.local.set({ sra_personal_baseline: baselineFeatures, sra_baseline_wpm: wpm });
                  _log('Personal baseline saved:', baselineFeatures);
                }
              }
            }
          });
          try { await gazeUtils.saveWebgazerModel(); } catch(e) {}
          sendResponse({ status: 'ok', result });
        } catch (e) {
          sendResponse({ status: 'error', error: String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'startCamera') {
      window.__sra_tracker_started = false;
      try { await startTracker(); sendResponse({status:'ok'}); }
      catch (e) { sendResponse({status:'error',error:String(e)}); }
      return true;
    }
    if (msg.type === 'simulateState') {
      // Demo/test: force-trigger a cognitive state action regardless of gaze data
      const state = msg.state;
      lastCogState = state;
      lastActionAt = 0; // reset cooldown so it fires immediately
      const action = COGNITIVE_STATE_ACTIONS[state];
      if (action === 'explain' || action === 'simplify') {
        // Use the element at centre of viewport as target paragraph
        const cx = window.innerWidth  / 2;
        const cy = window.innerHeight / 2;
        findParagraphAt(cx, cy).then(para => {
          if (para) { currentParagraph = para; triggerAIForParagraph(para, state); }
          else _warn('No paragraph found at viewport centre for simulate');
        });
      } else if (action === 'nudge') {
        const el = currentParagraph?.type === 'dom' ? currentParagraph.data : null;
        showNudge(el); if (el) highlightElement(el, 3000);
      }
      sendResponse({ status: 'ok', state });
      return true;
    }

    if (msg.type === 'getState') {
      sendResponse({ state: lastCogState, cameraReady: cameraIsReady });
      return;
    }

    if (msg.type === 'pageSummary') {
      (async () => {
        try {
          const text = extractPageText();
          if (!text) { sendResponse({ status: 'error', error: 'No readable text found.' }); return; }
          const summary = await fetchSummary(text, 'page_summary');
          if (summary) showPageSummaryPanel(summary);
          sendResponse({ status: summary ? 'ok' : 'error' });
        } catch (e) { sendResponse({ status: 'error', error: String(e) }); }
      })();
      return true;
    }
  });

  function extractPageText() {
    const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','NAV','FOOTER','HEADER']);
    const els  = document.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,td,th');
    const parts = [];
    let total = 0;
    for (const el of els) {
      if ([...el.closest ? [el] : []].some(n => {
        let p = n; while (p) { if (skip.has(p.tagName) || p.classList?.contains('sra-popup') || p.classList?.contains('sra-sidebar')) return true; p = p.parentElement; } return false;
      })) continue;
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length < 10) continue;
      const prefix = /^H[1-4]$/.test(el.tagName) ? '#'.repeat(+el.tagName[1]) + ' ' : '';
      parts.push(prefix + t);
      total += t.length;
      if (total > 6000) break;
    }
    return parts.join('\n\n').slice(0, 6000);
  }

  function showPageSummaryPanel(markdownText) {
    document.querySelector('.sra-page-summary-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'sra-page-summary-overlay';

    const panel = document.createElement('div');
    panel.className = 'sra-page-summary-panel';

    // Convert **bold** and bullet • to simple HTML
    const html = esc(markdownText)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^• /gm, '&bull; ')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');

    panel.innerHTML = `
      <button class="sra-ps-close" title="Close">×</button>
      <h2>Page Overview</h2>
      <div class="sra-page-summary-body">${html}</div>`;

    panel.querySelector('.sra-ps-close').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  // ── SPA navigation: close unpinned popups, badge pinned ones as stale ────
  function onSpaNavigate() {
    for (const [fp, { el }] of [...openPopups.entries()]) {
      if (!el || !document.contains(el)) { openPopups.delete(fp); continue; }
      if (el.dataset.pinned !== 'true') {
        closePopup(el, fp);
      } else {
        // Warn user that this popup belongs to the previous page
        if (!el.querySelector('.sra-stale-notice')) {
          const notice = document.createElement('div');
          notice.className = 'sra-stale-notice';
          notice.textContent = '↑ from previous page';
          notice.style.cssText = 'font-size:9px;color:#aaa;font-style:italic;padding:0 0 4px;';
          el.querySelector('.sra-popup-body')?.prepend(notice);
        }
      }
    }
    inFlightFingerprints.clear();
  }

  if (!window.__sra_history_patched) {
    window.__sra_history_patched = true;
    const _patchHistory = (method) => {
      const orig = history[method];
      history[method] = function (...args) {
        const result = orig.apply(this, args);
        onSpaNavigate();
        return result;
      };
    };
    _patchHistory('pushState');
    _patchHistory('replaceState');
    window.addEventListener('popstate', onSpaNavigate);
  }

  // ── Resize: re-clamp all visible popups to the new viewport bounds ───────
  if (!window.__sra_resize_watcher) {
    window.__sra_resize_watcher = true;
    let _resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const m  = POPUP_MARGIN;
        for (const [, { el }] of openPopups.entries()) {
          if (!el || !document.contains(el) || !el.classList.contains('show')) continue;
          const pw = el.offsetWidth  || 360;
          const ph = el.offsetHeight || 150;
          el.style.left = clamp(parseFloat(el.style.left) || 0, m, vw - pw - m) + 'px';
          el.style.top  = clamp(parseFloat(el.style.top)  || 0, m, vh - ph - m) + 'px';
        }
      }, 150);
    });
  }

  // ── Session continuity ────────────────────────────────────────────────
  function saveLastVisit() {
    try {
      const scrollPct = window.scrollY /
        Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      chrome.storage.local.get({ sra_last_visit: {} }, ({ sra_last_visit: lv }) => {
        lv[window.location.href] = {
          title: document.title, scrollPct,
          lastCogState, timestamp: Date.now(),
        };
        const keys = Object.keys(lv);
        if (keys.length > 200) {
          const oldest = keys.sort((a, b) => (lv[a].timestamp || 0) - (lv[b].timestamp || 0))[0];
          delete lv[oldest];
        }
        chrome.storage.local.set({ sra_last_visit: lv });
      });
    } catch (_) {}
  }

  function checkLastVisit() {
    chrome.storage.local.get({ sra_last_visit: {} }, ({ sra_last_visit: lv }) => {
      const last = lv[window.location.href];
      if (!last || Date.now() - last.timestamp > 7 * 86400000) return;
      const mins = Math.round((Date.now() - last.timestamp) / 60000);
      const ago  = mins < 60 ? `${mins}m ago` : mins < 1440
        ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
      const pct  = Math.round((last.scrollPct || 0) * 100);
      const state = last.lastCogState || '';

      const toast = document.createElement('div');
      toast.id = 'sra-continuity-toast';
      toast.style.cssText = [
        'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);',
        'background:rgba(26,30,28,0.92);color:#e8e8e4;font-family:Fraunces,Georgia,serif;',
        'font-size:12px;padding:10px 16px;border-radius:12px;z-index:2147483640;',
        'display:flex;align-items:center;gap:12px;box-shadow:0 4px 18px rgba(0,0,0,0.3);',
        'max-width:480px;backdrop-filter:blur(6px);',
      ].join('');

      const stateTag = state
        ? `<span style="background:rgba(26,126,93,0.3);padding:1px 7px;border-radius:4px;font-style:italic;">${state}</span>`
        : '';
      toast.innerHTML = `
        <span>↩ Back ${ago}${stateTag ? ' · last state: ' + stateTag : ''}</span>
        ${pct > 5 ? `<button id="sra-cont-restore" style="background:rgba(26,126,93,0.7);border:none;color:#fff;padding:4px 10px;border-radius:7px;cursor:pointer;font-family:inherit;font-size:11px;">Scroll to ${pct}%</button>` : ''}
        <button id="sra-cont-dismiss" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:16px;padding:0 2px;">×</button>`;

      document.body.appendChild(toast);
      setTimeout(() => toast.classList && (toast.style.opacity = '0', toast.style.transition = 'opacity 0.4s'), 7000);
      setTimeout(() => { try { toast.remove(); } catch (_) {} }, 7500);

      toast.querySelector('#sra-cont-dismiss')?.addEventListener('click', () => toast.remove());
      toast.querySelector('#sra-cont-restore')?.addEventListener('click', () => {
        const target = Math.round((last.scrollPct || 0) *
          (document.documentElement.scrollHeight - window.innerHeight));
        window.scrollTo({ top: target, behavior: 'smooth' });
        toast.remove();
      });
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  await detectAndInitHandlers();
  await startTracker();
  restoreHighlightMarkers();
  restoreTextHighlights();
  checkLastVisit();
  window.addEventListener('beforeunload', () => {
    try { sessionTracker.save(); } catch (e) {}
    saveLastVisit();
  });

  _log('Content script loaded ✓');

})();
} // end __sra_main