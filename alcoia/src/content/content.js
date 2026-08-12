/*
  content.js — alcoia Extension Core
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

const _log  = (...a) => console.log('[alcoia]', ...a);
const _warn = (...a) => console.warn('[alcoia]', ...a);

(async function () {

  // ── Constants ──────────────────────────────────────────────────────────
  const BACKEND_DEFAULT     = 'http://localhost:3000/api/summarize';
  const MIN_SELECTION_CHARS = 15;
  // Interruption cooldowns and budget now live in intervention-policy.js —
  // one place, applied to telemetry and gaze alike.
  // Popup geometry, the open-popup registry and the eviction cap now live in
  // ui-controller.js — it owns everything the reader sees.
  // Fingerprints of paragraphs currently awaiting an AI response (race-condition guard)
  const inFlightFingerprints = new Set();
  // Session-level cache: mode:fingerprint → summary text (cleared on page unload)
  const _summaryCache        = new Map();

  // ── Runtime state ──────────────────────────────────────────────────────
  /* The popup's master switch. It used to write `sra_enabled` to storage and
   * nothing anywhere read it, so turning the assistant "off" changed nothing
   * at all — the detectors kept running, cards kept appearing, and the only
   * way to actually stop it was chrome://extensions. It is wired now. */
  let assistantEnabled   = true;
  let backendUrl         = BACKEND_DEFAULT;
  // Off until the reader turns it on. This is the boot value used before
  // storage answers, so `true` here would start a webcam on a fresh profile.
  let eyeTrackingEnabled = false;
  let selectionEnabled   = true;
  let highlightEnabled   = true;
  let autohideEnabled    = false;
  let autohideTimeoutSec = 12;
  let pinDefault         = false;
  let debugEnabled       = false;
  let lastCogState       = 'unknown';
  let lastActionAt       = 0;           // manual/simulate paths only; automatic ones use the policy
  let orchestrator       = null;
  let currentParagraph   = null;
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
        s.textContent = '[data-sra-summarized]{border-left:2px solid rgba(126,96,174,0.3)!important;padding-left:6px!important;}';
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

  // ── Inject the overlay stylesheet and its fonts ───────────────────────
  // Both are packaged. The font sheet used to point at fonts.googleapis.com,
  // which handed Google one request per page the reader opened, carrying
  // their IP and the referring page. Nothing this extension draws is worth
  // that. fonts.css goes first so @font-face is registered before overlay.css
  // asks for it.
  if (!document.querySelector('[data-sra-font]')) {
    const f = document.createElement('link');
    f.rel = 'stylesheet'; f.dataset.sraFont = '1';
    f.href = chrome.runtime.getURL('src/styles/fonts.css');
    document.head.appendChild(f);
  }
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
  const idleModule   = await loadModule('src/content/idle-overlay.js');
  const { updateIdleState, forceStopIdle } = idleModule;
  const compModule  = await loadModule('src/content/comprehension-monitor.js');
  const readCalModule = await loadModule('src/content/reading-calibration.js');
  const { runReadingCalibration } = readCalModule;
  const ttsModule      = await loadModule('src/content/tts-handler.js');
  const rulerModule    = await loadModule('src/content/focus-ruler.js');
  const dyslexiaModule  = await loadModule('src/content/dyslexia-utils.js');
  const segmentation     = await loadModule('src/content/telemetry/segmentation.js');
  const langDetectModule = await loadModule('src/content/lang-detect.js');
  const mapModule       = await loadModule('src/content/reading-map.js');

  const ttsHandler    = ttsModule.createTTSHandler();
  const focusRuler    = rulerModule.createFocusRuler();
  const dyslexiaUtils = dyslexiaModule;
  let scriptInfo = langDetectModule.detectScript();
  langDetectModule.watchScriptChanges(newInfo => {
    scriptInfo = newInfo;
    _log(`Script re-detected: RTL=${newInfo.isRTL} CJK=${newInfo.isCJK} lang="${newInfo.lang}"`);
  });
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

  const featureExtractor = featModule.createFeatureExtractor({
    windowMs: 2500, minPoints: 15,
    // The paragraph being read defines the text column for on_page_fraction.
    // Returns null before anything is being tracked, and the extractor then
    // abstains rather than reporting a fraction it cannot compute.
    getContentRect: () => {
      try {
        const el = orchestrator?.getActiveParagraphEl()
          || (currentParagraph?.type === 'dom' ? currentParagraph.data : null);
        return el ? el.getBoundingClientRect() : null;
      } catch (e) { return null; }
    },
  });
  const { classifyGazeState, COGNITIVE_STATE_ACTIONS } = classModule;

  // ── UI ─────────────────────────────────────────────────────────────────
  const uiModule = await loadModule('src/content/ui-controller.js');
  const { esc, clamp, applyDarkMode } = uiModule;
  const ui = uiModule.createUIController({
    // Read through a getter: the storage listener reassigns these at runtime
    // and a captured copy would go stale.
    getSettings: () => ({
      highlightEnabled, pinDefault, autohideEnabled, autohideTimeoutSec,
    }),
    fetchSummary: (...a) => fetchSummary(...a),
  });
  const {
    openPopups, highlightElement, closePopup, flashPopup, hidePopup,
    reservePopup, showPopup, renderPopup,
    showNudge, showSimulateToast, showQualityToast,
  } = ui;

  // ── Question layer ─────────────────────────────────────────────────────
  const responseModule = await loadModule('src/content/telemetry/response-signals.js');
  const cardModule     = await loadModule('src/content/question-card.js');
  const responseSignals = responseModule.createResponseSignals();
  const recallModule = await loadModule('src/content/telemetry/session-recall.js');
  const sessionRecall = recallModule.createSessionRecall();

  // ── Receipt ────────────────────────────────────────────────────────────
  // Reader-generated only. Nothing below runs on a timer, and nothing leaves
  // the machine without a click in the preview panel.
  const receiptModule = await loadModule('src/content/receipt.js');
  const receiptPanel = receiptModule.createReceiptPanel({
    esc,
    signReceipt: async (receipt) => {
      const url = (backendUrl || BACKEND_DEFAULT).replace(/\/api\/summarize\/?$/, '/api/receipt/sign');
      const j = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ action: 'apiPost', url, body: { receipt } }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) { resolve(null); return; }
            resolve(resp.data);
          });
        } catch (e) { resolve(null); }
      });
      return j && j.receipt ? j.receipt : null;
    },
  });

  function buildCurrentReceipt() {
    const paragraphs = document.querySelectorAll('p, li, blockquote').length;
    // Whitespace counting reported a whole Chinese article as one word, and
    // that figure is a field of the reader's receipt.
    const wordCount = segmentation.countWords(document.body.innerText || '', segmentation.detectLanguage());
    return receiptModule.buildReceipt({
      session: sessionTracker.snapshot(),
      recall: responseSignals.stats(),
      recallItems: responseSignals.history(),
      reading: sessionRecall.stats(),
      progression: orchestrator.progressionStats(),
      regressions: orchestrator.regressionStats(),
      interaction: orchestrator.interactionStats(),
      document: { title: document.title, url: window.location.href, wordCount, paragraphs },
    });
  }

  function showReceipt() { receiptPanel.show(buildCurrentReceipt()); }
  const questionCard = cardModule.createQuestionCard({
    ui,
    esc,
    responseSignals,
    // Scoped to the sentence the reader missed, not the whole paragraph.
    fetchExplanation: (spanText) => fetchSummary(spanText, 'explain_more'),
    onAnswered: (record) => {
      // An answer outranks every telemetry signal — see state-engine.js.
      try { orchestrator.pumpTelemetry(record); } catch (e) {}
      try { sessionTracker.recordSignal('response', record.subtype, record.span || ''); } catch (e) {}
      // A paragraph already answered correctly is a poor use of a recall slot.
      if (record.paragraphKey) sessionRecall.recordAnswered(record.paragraphKey, record.correct);
    },
    onDismissed: () => { /* declining to be tested says nothing; record nothing */ },
  });

  // ── Detection pipeline ─────────────────────────────────────────────────
  // orchestrator.js owns the detectors, the state engine and the interruption
  // budget. It decides; this file renders. onIntervention returns whether
  // anything actually reached the screen, and the budget is spent only on a
  // yes — an offer that bails out here must not burn one of the reader's five.
  const orchModule = await loadModule('src/content/orchestrator.js');
  orchestrator = await orchModule.createOrchestrator({
    loadModule,
    comprehensionMonitor,
    featureExtractor,
    classifyGazeState,
    getSmoothedState,
    gazeUtils,
    dyslexiaUtils,
    langDetect: langDetectModule,
    // Read live: the storage listener reassigns these at runtime.
    settings: () => ({
      assistantEnabled,
      comprehensionCheckEnabled, eyeTrackingEnabled, focusRulerEnabled,
      debugEnabled, dyslexiaEnabled, personalBaseline, scriptInfo,
    }),
    host: {
      sessionTracker,
      focusRuler,
      log: _log,
      findParagraphAt: (x, y) => findParagraphAt(x, y),
      getCurrentParagraph: () => currentParagraph,
      setCurrentParagraph: (p) => { currentParagraph = p; },
      setPrevParagraphText: (t) => { prevParagraphText = t; },
      setCogState: (label) => { lastCogState = label; },
      getLastGazePoint: () => lastGazePt,
      // Reading an open card is not fresh confusion. Without this, letting your
      // gaze settle on a popup pops another one on top of it.
      isReadingAPopup: () => { try { return ui.isGazeOverAnyPopup(lastGazePt); } catch (e) { return false; } },
      getLastGazeReceivedAt: () => lastGazeReceivedAt,
      onQualityWarning: () => showQualityToast(),
      onParagraphRead: (text, dwellMs) => sessionRecall.recordRead(text, dwellMs),
      onStruggle: (text) => sessionRecall.recordStruggle(text),
      onGazeFeatures: (rawFeatures) => {
        if (idleBlinkEnabled) updateIdleState(rawFeatures, lastGazePt, lastGazeReceivedAt);
        else forceStopIdle();
      },
      onIntervention: async (decision, state, target) => {
        // Off means off: nothing reaches the screen, and the budget is not
        // spent on an offer that was never made.
        if (!assistantEnabled) return false;
        if (decision.action === 'nudge') {
          showNudge(target);
          if (target) highlightElement(target, 3000);
          return true;
        }
        if (decision.action === 'ask') {
          return await handleAsk(decision, state, target);
        }
        // A telemetry signal knows which paragraph it came from.
        if (state.signal) {
          return await handleComprehensionSignal(state.signal, decision.evidence, target);
        }
        if (currentParagraph) {
          await triggerAIForParagraph(currentParagraph, state.label);
          return true;
        }
        return false;
      },
    },
  });

  // ── Load settings ──────────────────────────────────────────────────────
  // Boot waits on this. Settings load asynchronously, and starting the tracker
  // before they arrive means booting the camera on the `sra_eye: true` default
  // regardless of what the reader actually chose.
  let settingsLoaded;
  const settingsReady = new Promise((resolve) => { settingsLoaded = resolve; });

  chrome.storage.local.get({
    sra_enabled: true,
    sra_backend_url: BACKEND_DEFAULT, sra_eye: false, sra_selection: true,
    sra_highlight_para: true, sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_idle_blink: true, sra_comprehension: true,
    sra_tts: false, sra_focus_ruler: false, sra_dyslexia: false,
    sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
    sra_personal_baseline: null, sra_baseline_wpm: null, sra_dark_mode: false,
  }, (res) => {
    backendUrl         = res.sra_backend_url || BACKEND_DEFAULT;
    assistantEnabled   = res.sra_enabled !== false;
    eyeTrackingEnabled = res.sra_eye === true;
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
    settingsLoaded();
  });

  // ── Utilities ──────────────────────────────────────────────────────────
  // esc and clamp live in ui-controller.js, imported above with the rest of it.

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

      // Route the request through the background service worker rather than
      // fetching directly. A direct fetch from a content script carries the
      // host PAGE's origin (e.g. https://en.wikipedia.org), which the server's
      // CORS policy correctly rejects. The background worker's fetch carries no
      // page origin, so it passes CORS while keeping the server locked down to
      // the extension only. Falls back to a direct fetch if messaging fails.
      const j = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ action: 'summarize', url, body }, (resp) => {
            if (chrome.runtime.lastError || !resp) { resolve(null); return; }
            if (!resp.ok) { _warn(`Server ${resp.status || ''} ${resp.error || ''}`); resolve(null); return; }
            resolve(resp.data);
          });
        } catch (e) { resolve(null); }
      });
      if (!j) return null;

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


  // ── Simulated states (testing only) ────────────────────────────────────
  // The panel and these shortcuts speak the engine's vocabulary — on_pace,
  // skimming, struggling, drifting. The classifier's action table still uses
  // the older labels it was trained against, so the translation lives here
  // rather than leaking old names back into the UI. `simplify` is kept
  // reachable on Alt+2 because nothing else exercises that renderer.
  const SIM_ACTIONS = Object.freeze({
    struggling: 'explain',
    drifting:   'nudge',
    skimming:   'none',
    on_pace:    'none',
    absent:     'none',
    unknown:    'none',
  });
  const SIM_KEYS = Object.freeze({
    '1': 'struggling', '2': 'struggling:simplify',
    '3': 'drifting', '4': 'skimming', '5': 'on_pace',
  });

  async function runSimulatedState(spec) {
    const [state, forced] = String(spec).split(':');
    const action = forced || SIM_ACTIONS[state] || COGNITIVE_STATE_ACTIONS[state] || 'none';

    showSimulateToast(state);
    lastActionAt = 0;
    lastCogState = state;
    try { chrome.storage.local.set({ sra_current_state: state }); } catch (e) {}

    if (action === 'explain' || action === 'simplify') {
      const para = await findParagraphAt(window.innerWidth / 2, window.innerHeight / 2);
      if (para) { currentParagraph = para; await triggerAIForParagraph(para, state); }
      else _warn('No paragraph found at viewport centre for simulate');
    } else if (action === 'nudge') {
      const el = currentParagraph?.type === 'dom' ? currentParagraph.data : null;
      showNudge(el); if (el) highlightElement(el, 3000);
    }
    return state;
  }

  if (!window.__sra_esc_installed) {
    window.__sra_esc_installed = true;

    document.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { hidePopup(); return; }
      if (!e.altKey) return;
      // Escape still closes whatever is open; every other shortcut is inert
      // while the assistant is switched off, so the page keeps its own keys.
      if (!assistantEnabled) return;

      // Alt+1–5: force a state's intervention, for testing.
      const simState = SIM_KEYS[e.key];
      if (simState) {
        e.preventDefault();
        await runSimulatedState(simState);
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

      // Alt+I: show the reading receipt for this session
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        showReceipt();
        return;
      }

      // Alt+R: review what you have read this session
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        runSessionRecall();
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


  // ── Questions ──────────────────────────────────────────────────────────
  // The primary intervention. Asking beats summarising because an answer is
  // the only thing here that produces ground truth, and because summarising
  // removes the difficulty that produces retention in the first place.
  const questionsUrl = () => (backendUrl || BACKEND_DEFAULT).replace(/\/api\/summarize\/?$/, '/api/questions');

  async function fetchQuestions(text, opts = {}) {
    if (!text || text.trim().length < 120) return [];
    const body = {
      text: text.slice(0, 3500),
      language: (document.documentElement.lang || '').slice(0, 5),
      count: opts.count || 1,
      kind: opts.kind || 'recall',
    };
    // Through the background worker, for the same CORS reason as fetchSummary:
    // a content script's fetch carries the host page's origin and the server
    // rejects it. A direct fetch here works only when the page happens to be
    // same-origin with the server, which is true in tests and false in life.
    const j = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'apiPost', url: questionsUrl(), body }, (resp) => {
          if (chrome.runtime.lastError || !resp) { resolve(null); return; }
          if (!resp.ok) {
            // 422 means nothing passed the server's citation check; 503 means
            // no key. Both are ordinary outcomes and both fall back to
            // explaining rather than showing the reader an error.
            _log(`Questions unavailable (${resp.status || resp.error || 'error'})`);
            resolve(null);
            return;
          }
          resolve(resp.data);
        });
      } catch (e) { resolve(null); }
    });
    if (!j) return [];
    return Array.isArray(j.questions) ? j.questions : [];
  }

  /* Returns true only if a card reached the screen. */
  async function handleAsk(decision, state, target) {
    const el = target || (currentParagraph?.type === 'dom' ? currentParagraph.data : null);
    const text = el ? (el.innerText || el.textContent || '').trim() : (state.signal?.text || '');
    if (!text) return false;

    const questions = await fetchQuestions(text);
    if (!questions.length) {
      // No question could be generated or none cited its evidence. Fall back
      // to the explanation card rather than dropping the interruption.
      if (state.signal) return await handleComprehensionSignal(state.signal, decision.evidence, el);
      if (el) { await triggerAIForParagraph({ type: 'dom', data: el }, state.label); return true; }
      return false;
    }

    let anchorRect = null;
    try { if (el) anchorRect = el.getBoundingClientRect(); } catch (e) {}
    if (el) highlightElement(el, 4000);

    return questionCard.show(questions[0], {
      evidence: decision.evidence,
      anchorRect,
      paragraphKey: text.slice(0, 80).trim(),
    });
  }

  // ── Session recall ─────────────────────────────────────────────────────
  // Retrieval practice over what was actually read, weighted toward the
  // paragraphs that gave the reader trouble. Reader-initiated only: this never
  // fires on its own, and nothing about it is submitted anywhere.
  let recallRunning = false;

  async function runSessionRecall(count = 5) {
    if (recallRunning) return;
    const picked = sessionRecall.select(count);
    if (!picked.length) {
      showSimulateToast('Nothing read yet to review');
      return;
    }

    recallRunning = true;
    try {
      const questions = [];
      for (const entry of picked) {
        const qs = await fetchQuestions(entry.text, { count: 1 });
        if (qs.length) questions.push({ question: qs[0], paragraphKey: entry.text.slice(0, 80).trim() });
        if (questions.length >= count) break;
      }

      if (!questions.length) {
        showSimulateToast('Could not prepare a review right now');
        return;
      }

      // One at a time. A wall of questions is a test; one question is a check.
      for (const item of questions) {
        const shown = questionCard.show(item.question, {
          evidence: ['Reviewing what you read this session'],
          paragraphKey: item.paragraphKey,
        });
        if (!shown) continue;
        await waitForCardToClose();
      }
    } finally {
      recallRunning = false;
    }
  }

  function waitForCardToClose() {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const open = document.querySelector('.sra-popup .sra-q-options');
        // Resolve on close, or bail out after two minutes so a forgotten card
        // cannot wedge the run forever.
        if (!open || Date.now() - started > 120000) { clearInterval(tick); resolve(); }
      }, 400);
    });
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
      fontFamily: "var(--alc-serif, Georgia, serif)",
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

  // ── Selection alcoia (or Ctrl+drag → colour highlight) ──────────────────
  document.addEventListener('mouseup', async (ev) => {
    if (!assistantEnabled) return;
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
      renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text, source:'reading', trigger:reason, triggerLabel });
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
      else if (lastCogState === 'struggling' && Date.now() - _imageDwellStart > 2000) {
        const _ifp = 'img:' + (_gazeImg.src || '').slice(-60) + ':' + (_gazeImg.alt || '').slice(0, 20);
        if (!inFlightFingerprints.has(_ifp)) {
          _imageDwellStart = Date.now() + 30000; // suppress for 30s after trigger
          triggerImageExplanation(_gazeImg, pt.x, pt.y, lastCogState);
        }
      }
    } else {
      _imageDwellEl = null;
    }

    // Pause autohide on any card the gaze is resting on (from main).
    try { ui.updateGazeOverPopups(pt); } catch (e) {}

    // Focus ruler follows gaze Y in real time
    if (focusRulerEnabled) focusRuler.update(pt.y);

    try {
      const f = await findParagraphAt(pt.x, pt.y);
      if (f) {
        const isPopup = f.type === 'dom' && f.data &&
          (f.data.classList?.contains('sra-popup') || !!f.data.closest?.('.sra-popup'));
        if (!isPopup) {
          if (comprehensionCheckEnabled && f.type === 'dom' && f.data !== (currentParagraph && currentParagraph.data)) {
            // Paragraph timing is owned by paragraph-tracker via syncParagraph()
            // now — it works with the camera off, which this path never did.
            // Gaze still refines which paragraph is under the reader.
            if (currentParagraph?.type === 'dom' && currentParagraph.data) {
              prevParagraphText = (currentParagraph.data.innerText || currentParagraph.data.textContent || '')
                .trim().slice(0, 800);
            }
          }
          currentParagraph = f;
        }
      }
    } catch (e) {}
  }

  // ── Comprehension signal handler ──────────────────────────────────────────
  // Renderer only. It no longer decides whether to interrupt — the state engine
  // produces the state and intervention-policy decides. Call it from the engine
  // subscriber, never directly from a detector.
  // Returns true only if an offer actually reached the screen. The caller uses
  // that to decide whether to spend the interruption budget — an offer that
  // bailed out here must not count against the reader's five.
  async function handleComprehensionSignal(signal, evidence = [], targetEl = null) {
    if (!comprehensionCheckEnabled) return false;

    // Keeps the monitor's own 30s cooldown honest. The session record is
    // written by the engine subscriber, which sees every interruption.
    comprehensionMonitor.markOfferShown();

    const el = (signal.type === 'speed_mismatch' && signal.el) ? signal.el
              : (currentParagraph?.type === 'dom' ? currentParagraph.data : targetEl);

    if (el) highlightElement(el, 4000);

    let text = signal.text || '';
    if (!text && el) text = (el.innerText || el.textContent || '').trim();
    if (!text) return false;

    let anchorRect = null;
    try { if (el) anchorRect = el.getBoundingClientRect(); } catch (e) {}

    const fingerprint = 'comp-' + text.slice(0, 80).trim();
    // reservePopup handles both dedup (flashes the existing card) and the
    // MAX_POPUPS cap. This renderer used to do the first and not the second,
    // so a page full of pinned cards could still stack another one on top.
    // Null means nothing was shown, and the caller must not spend the budget.
    const root = reservePopup(fingerprint);
    if (!root) return false;

    const offerHtml = buildComprehensionOfferHtml(signal, evidence);

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

    showPopup(root, anchorRect);
  }

  // Every interruption has to show the reader what was actually observed —
  // that turns an inference into an observation they can disagree with.
  // The evidence strings come from the state engine.
  function buildComprehensionOfferHtml(signal, evidence = []) {
    const observed = evidence.length
      ? `<div style="line-height:1.7"><strong>${esc(evidence[0])}.</strong></div>`
      : '';

    if (signal.type === 'speed_mismatch' && signal.subtype === 'too_slow') {
      const detail = (signal.actualWpm && signal.baselineWpm)
        ? `You read this stretch at about ${signal.actualWpm} words per minute; your usual pace is
           around ${signal.baselineWpm}.`
        : 'You spent noticeably longer here than you usually do.';
      return `<div class="sra-state-badge" style="color:#9A6B2F;border-color:rgba(154,107,47,0.3);background:rgba(154,107,47,0.06)">
        reading pace check</div>
        ${observed}
        <div style="line-height:1.7">${detail}
        <br><em style="color:var(--muted)">Want a hand with it?</em></div>`;
    }

    if (signal.type === 'speed_mismatch') {
      const r = signal.readability;
      // elapsed/expected are only present on the too_fast signal — guard rather
      // than rendering NaN, which is what the previous version did for too_slow.
      const haveTiming = Number.isFinite(signal.elapsed) && Number.isFinite(signal.expected);
      const timing = haveTiming
        ? `you moved through it in ${Math.round(signal.elapsed / 1000)}s — expected at least
           ${Math.round(signal.expected / 1000)}s for text this dense.`
        : 'you moved through it faster than text this dense usually takes.';
      const score = r && Number.isFinite(r.score) ? ` (readability score ${r.score.toFixed(0)}/100)` : '';
      return `<div class="sra-state-badge" style="color:#9A6B2F;border-color:rgba(154,107,47,0.3);background:rgba(154,107,47,0.06)">
        reading pace check</div>
        ${observed}
        <div style="line-height:1.7">That was a <strong>complex paragraph</strong>${score} but ${timing}
        <br><em style="color:var(--muted)">Want a quick summary?</em></div>`;
    }

    if (signal.type === 'backtrack') {
      return `<div class="sra-state-badge" style="color:#7E6E5A;border-color:rgba(126,110,90,0.3);background:rgba(126,110,90,0.06)">
        scroll backtrack</div>
        ${observed}
        <div style="line-height:1.7">Looks like something might not have landed clearly.
        <br><em style="color:var(--muted)">Want a summary of what you just passed?</em></div>`;
    }

    return `${observed}<div>Want a summary?</div>`;
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
                // Restore the saved regression model for a warm start, then let
                // continuous click recording refine it for the current session.
                _log('Calibration persisted — restoring model from previous session');
                await gazeUtils.restoreWebgazerModel();
              } else {
                _log('First-time calibration starting...');
                const cal = await gazeUtils.runCalibrationSequence();
                if (cal) {
                  await gazeUtils.setCalibration(cal);
                  chrome.storage.local.set({ sra_ever_calibrated: true });
                  await gazeUtils.saveWebgazerModel();
                  _log('First-time calibration complete and saved');
                }
              }
            } catch (e) {
              _warn('Calibration step failed (non-fatal):', e.message);
            }
            orchestrator.startClassificationLoop();
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

  // ── PDF/PPTX handlers ─────────────────────────────────────────────────
  async function detectAndInitHandlers() {
    const url = window.location.href;
    if (/\.pdf($|[?#])/i.test(url) || document.querySelector('embed[type="application/pdf"]')) {
      try { const m = await loadModule('src/content/pdf-handler.js'); pdfHandler = await m.initPDFHandler(); } catch(e) {_warn('PDF:',e);}
    }
    if (/\.pptx($|[?#])/i.test(url) || document.querySelector('a[href$=".pptx"]')) {
      try { const m = await loadModule('src/content/pptx-handler.js'); pptxHandler = await m.initPPTXHandler(); } catch(e) {_warn('PPTX:',e);}
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.sra = window.sra || {};
  window.sra.runCalibration = async () => {
    const cal = await gazeUtils.runCalibrationSequence();
    if (cal) {
      await gazeUtils.setCalibration(cal);
      await gazeUtils.saveWebgazerModel();
    }
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
        try {
          const cal = await gazeUtils.runCalibrationSequence();
          if (cal) {
            await gazeUtils.setCalibration(cal);
            await gazeUtils.saveWebgazerModel();
            // Mark calibrated so the auto-modal doesn't reappear on future pages
            chrome.storage.local.set({ sra_ever_calibrated: true });
          }
          sendResponse({ status: 'ok', calibration: cal });
        }
        catch (e) { sendResponse({ status: 'error', error: String(e) }); }
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
                // The WPM is persisted on its own. It used to be written only
                // inside the gaze-baseline branch below, so with the camera
                // off — where computeFeatures() returns null — the number the
                // reader had just sat there measuring survived only until the
                // page unloaded.
                chrome.storage.local.set({ sra_baseline_wpm: wpm });

                // Gaze feature baseline, when there was a camera producing one.
                const baselineFeatures = featureExtractor.computeFeatures();
                if (baselineFeatures) {
                  personalBaseline = baselineFeatures;
                  chrome.storage.local.set({ sra_personal_baseline: baselineFeatures });
                  _log('Personal baseline saved:', baselineFeatures);
                }
              }
            }
          });
          try { await gazeUtils.saveWebgazerModel(); } catch(e) {}
          // Mark calibrated so the auto dot-calibration modal doesn't reappear
          chrome.storage.local.set({ sra_ever_calibrated: true });
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
    if (msg.action === 'sessionRecall') {
      runSessionRecall(msg.count || 5);
      sendResponse({ status: 'ok', stats: sessionRecall.stats() });
      return true;
    }
    if (msg.action === 'showReceipt') {
      showReceipt();
      sendResponse({ status: 'ok' });
      return true;
    }
    if (msg.action === 'recallStats') {
      sendResponse({ status: 'ok', stats: sessionRecall.stats() });
      return true;
    }
    if (msg.type === 'simulateState') {
      // Demo/test: force a state's intervention regardless of what the
      // detectors think. Same path as Alt+1–5.
      runSimulatedState(msg.state);
      sendResponse({ status: 'ok', state: msg.state });
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

  // Resize re-clamping lives in ui-controller.js — it is popup geometry.
  ui.installResizeWatcher();

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
        'background:rgba(26,30,28,0.92);color:#e8e8e4;font-family:var(--alc-ui,system-ui,sans-serif);',
        'font-size:12px;padding:10px 16px;border-radius:12px;z-index:2147483640;',
        'display:flex;align-items:center;gap:12px;box-shadow:0 4px 18px rgba(0,0,0,0.3);',
        'max-width:480px;backdrop-filter:blur(6px);',
      ].join('');

      const stateTag = state
        ? `<span style="background:rgba(126,96,174,0.3);padding:1px 7px;border-radius:4px;font-style:italic;">${state}</span>`
        : '';
      toast.innerHTML = `
        <span>↩ Back ${ago}${stateTag ? ' · last state: ' + stateTag : ''}</span>
        ${pct > 5 ? `<button id="sra-cont-restore" style="background:rgba(126,96,174,0.7);border:none;color:#fff;padding:4px 10px;border-radius:7px;cursor:pointer;font-family:inherit;font-size:11px;">Scroll to ${pct}%</button>` : ''}
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

  // Never boot the camera unless the reader turned it on. webgazer.begin()
  // calls getUserMedia, so starting the tracker speculatively would prompt for
  // the webcam on a page the reader only wanted read. Telemetry detection below
  // runs either way — it never needed the camera.
  await settingsReady;
  if (eyeTrackingEnabled) await startTracker();
  else _log('Eye tracking off — tracker not started, camera untouched');

  /* Turning the switch off has to leave the page as if the extension were
   * not installed: no cards, no ruler, no sidebar, no speech, no camera, and
   * no telemetry accruing in the background. Turning it back on resumes
   * whatever the reader's settings already said. */
  function setAssistantEnabled(on) {
    const was = assistantEnabled;
    assistantEnabled = !!on;
    if (was === assistantEnabled) return;

    if (!assistantEnabled) {
      try { hidePopup(true); } catch (e) { /* nothing open */ }
      try { ui.clearHighlight(); } catch (e) { /* nothing highlighted */ }
      try { focusRuler.disable(); } catch (e) { /* never enabled */ }
      try { forceStopIdle(); } catch (e) { /* no idle overlay */ }
      try { ttsHandler.stop(); } catch (e) { /* not speaking */ }
      try { document.getElementById('sra-reading-map')?.classList.remove('open'); } catch (e) {}
      try { document.querySelector('.sra-word-bubble')?.remove(); } catch (e) {}
      _log('Assistant switched off — page left alone');
    } else {
      if (focusRulerEnabled) { try { focusRuler.enable(); } catch (e) {} }
      try { orchestrator.primeParagraph(); } catch (e) {}
      _log('Assistant switched on');
    }
  }

  /* The popup only messages the active tab, so a settings broadcast would
   * leave every other open tab still running. Storage is the one channel
   * every tab hears. */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.sra_enabled) setAssistantEnabled(changes.sra_enabled.newValue !== false);
    });
  } catch (e) { /* no storage in this context */ }

  orchestrator.installListeners();
  orchestrator.primeParagraph();

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