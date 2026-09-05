/*
  content.js — alcoia Extension Core
  Guard at the very top prevents the SyntaxError when injected twice.
*/

// ── Double-injection guard ─────────────────────────────────────────────────
if (!window.__sra_content_loaded) {
  window.__sra_content_loaded = true;
  __sra_main();
}

function __sra_main() {

const _log  = (...a) => console.log('[alcoia]', ...a);
const _warn = (...a) => console.warn('[alcoia]', ...a);

(async function () {

  // ── Constants ──────────────────────────────────────────────────────────
  // Defined in src/shared/config.js, loaded as a preceding content script —
  // see manifests/base.json. One place for the shipped origin; a developer
  // overrides it at runtime via the popup's Backend URL setting instead of
  // editing source.
  const BACKEND_DEFAULT     = self.ALCOIA_CONFIG.SUMMARIZE_URL;
  const MIN_SELECTION_CHARS = 15;
  // Interruption cooldowns and budget live in intervention-policy.js — one
  // place, applied to every signal-driven decision.
  // Popup geometry, the open-popup registry and the eviction cap now live in
  // ui-controller.js — it owns everything the reader sees.
  // Fingerprints of paragraphs currently awaiting an AI response (race-condition guard)
  const inFlightFingerprints = new Set();
  // Item 30a: the AI-fetch pipeline (fetchSummary/fetchQuestions, their
  // cache, and item 38's rate limiting) now lives in host.js, since it is
  // required by orchestrator.js's host.onIntervention as much as by the
  // manual paths below. Reached here via hostApi.fetchSummary/fetchQuestions.

  // ── Runtime state ──────────────────────────────────────────────────────
  /* The popup's master switch. It used to write `sra_enabled` to storage and
   * nothing anywhere read it, so turning the assistant "off" changed nothing
   * at all — the detectors kept running, cards kept appearing, and the only
   * way to actually stop it was chrome://extensions. It is wired now. */
  let assistantEnabled   = true;
  let backendUrl         = BACKEND_DEFAULT;
  let selectionEnabled   = true;
  let highlightEnabled   = true;
  // Item 26: two independent controls, not one four-way mode — colour is a
  // free, client-only display preference; summarising is the AI-calling
  // half and defaults off. Read live through these lets, same as every
  // other setting here, so a change takes effect without a page reload.
  let highlightColorEnabled     = true;
  let highlightSummarizeEnabled = false;
  // "Keep highlights when I leave the page" — on by default, since silently
  // losing a deliberate highlight is the surprising behaviour. Off does not
  // delete anything already saved; it only stops applyTextHighlight() below
  // from writing new ones.
  let highlightPersistEnabled   = true;
  let autohideEnabled    = false;
  let autohideTimeoutSec = 12;
  let pinDefault         = false;
  let debugEnabled       = false;
  let lastActionAt       = 0;           // manual/simulate paths only; automatic ones use the policy
  let orchestrator       = null;
  // Item 30a: currentParagraph, prevParagraphText and lastCogState now live
  // in host.js — the exact state setCurrentParagraph/setPrevParagraphText/
  // setCogState/getCurrentParagraph hold. Reached here via
  // hostApi.host.getCurrentParagraph()/.setCurrentParagraph(), and
  // hostApi.getPrevParagraphText()/hostApi.getCogState().
  let pdfHandler         = null;
  let pptxHandler        = null;
  let comprehensionCheckEnabled = true;

  // ── New feature flags ──────────────────────────────────────────────────
  let ttsEnabled          = false;
  let focusRulerEnabled   = false;
  let darkModeEnabled     = false;
  let dyslexiaEnabled     = false;
  let dyslexiaColor       = 'rgba(255,243,180,0.12)';
  let bionicEnabled       = false;

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
  const overlayUtils = await loadModule('src/content/overlay-utils.js');
  const readCalModule = await loadModule('src/content/reading-calibration.js');
  const { runSelfPacedCalibration } = readCalModule;
  const ttsModule      = await loadModule('src/content/tts-handler.js');
  const dyslexiaModule  = await loadModule('src/content/dyslexia-utils.js');
  const segmentation     = await loadModule('src/content/signals/segmentation.js');
  const mapModule       = await loadModule('src/content/reading-map.js');
  const hlSidebarModule = await loadModule('src/content/highlights-sidebar.js');

  const ttsHandler    = ttsModule.createTTSHandler();
  const dyslexiaUtils = dyslexiaModule;
  const readingMap    = mapModule.createReadingMap();
  const highlightsSidebar = hlSidebarModule.createHighlightsSidebar();

  // ── UI ─────────────────────────────────────────────────────────────────
  const uiModule = await loadModule('src/content/ui-controller.js');
  const { esc, clamp, applyDarkMode } = uiModule;
  // hostApi is constructed just below and needs `ui` already built (it is a
  // single shared registry — CLAUDE.md: "ui-controller.js owns openPopups
  // and nothing else may mutate it" — so there can only ever be one
  // instance). ui's own fetchSummary callback is only ever invoked later,
  // from a click handler, never at construction time, so this deferred
  // reference (set right after hostApi exists, a few lines down) resolves
  // the circularity with no behavioural change — the same pattern this file
  // already uses for `orchestrator` itself.
  let hostApi = null;
  const ui = uiModule.createUIController({
    // Read through a getter: the storage listener reassigns these at runtime
    // and a captured copy would go stale.
    getSettings: () => ({
      highlightEnabled, pinDefault, autohideEnabled, autohideTimeoutSec,
    }),
    fetchSummary: (...a) => hostApi.fetchSummary(...a),
  });
  const {
    openPopups, highlightElement, closePopup, flashPopup, hidePopup,
    renderPopup,
    showNudge, showSimulateToast,
  } = ui;

  // ── Host (item 30a) ─────────────────────────────────────────────────────
  // Everything orchestrator.js's 12-callback host contract needs — the
  // AI-fetch pipeline (and item 38's rate limiting on it), the question
  // card, quiz generation, session recall/tracking, the focus ruler and
  // snooze — now lives in host.js, importable from a content script or an
  // extension page alike. See CLAUDE.md's "Extracting the host from
  // content.js (item 30a)" section for the full inventory and reasoning.
  const hostModule = await loadModule('src/content/host.js');
  hostApi = await hostModule.createHost({
    loadModule,
    ui,
    esc,
    log: _log,
    warn: _warn,
    // Read live: the storage listener reassigns these at runtime. A
    // deliberately small surface — only what host.js's own code reads.
    settings: () => ({ assistantEnabled, backendUrl }),
  });
  const {
    fetchSummary, callBackend,
    runQuiz, runSessionRecall, startSnooze, snoozeControl, SNOOZE_OPTIONS,
    sessionRecall, responseSignals, sessionTracker, focusRuler,
    comprehensionMonitor, setPdfHandler, setPptxHandler, getCogState,
    getPrevParagraphText, setOrchestrator,
    showSelfReportCard, // item 13a — affordance 1 (Alt+C, below)
  } = hostApi;
  const hostCallbacks = hostApi.host;

  // ── Receipt ────────────────────────────────────────────────────────────
  // Reader-generated only. Nothing below runs on a timer, and nothing leaves
  // the machine without a click in the preview panel.
  // Item DC-1a — loaded here (not lazily inside the beforeunload handler,
  // which cannot itself be async-awaited meaningfully) so shouldSubmitKinematics
  // is ready by the time the page might unload.
  const kinematicsModule = await loadModule('src/shared/kinematics.js');
  const receiptModule = await loadModule('src/content/receipt.js');
  const receiptPanel = receiptModule.createReceiptPanel({
    esc,
    signReceipt: async (receipt) => {
      const url = (backendUrl || BACKEND_DEFAULT).replace(/\/api\/summarize\/?$/, '/api/receipt/sign');
      const resp = await callBackend('apiPost', url, { receipt });
      const j = resp.ok ? resp.data : null;
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

  // ── Detection pipeline ─────────────────────────────────────────────────
  // orchestrator.js owns the detectors, the state engine and the interruption
  // budget. It decides; this file (via host.js) renders. onIntervention
  // returns whether anything actually reached the screen, and the budget is
  // spent only on a yes — an offer that bails out here must not burn one of
  // the reader's five.
  const orchModule = await loadModule('src/content/orchestrator.js');
  orchestrator = await orchModule.createOrchestrator({
    loadModule,
    comprehensionMonitor,
    // Read live: the storage listener reassigns these at runtime. A
    // separate accessor from host.js's own settings() above — orchestrator.js
    // reads a different, wider subset.
    settings: () => ({
      assistantEnabled,
      comprehensionCheckEnabled, focusRulerEnabled,
      debugEnabled,
    }),
    host: hostCallbacks,
  });
  // host.js's questionCard/runQuiz callbacks reference orchestrator, which
  // did not exist yet when they were built — see host.js's own header for
  // why this is safe (a reader cannot answer a question before boot
  // completes).
  setOrchestrator(orchestrator);

  // ── Load settings ──────────────────────────────────────────────────────
  // Boot waits on this so nothing acts on defaults before the reader's real
  // choices arrive.
  let settingsLoaded;
  const settingsReady = new Promise((resolve) => { settingsLoaded = resolve; });

  chrome.storage.local.get({
    sra_enabled: true,
    sra_backend_url: BACKEND_DEFAULT, sra_selection: true,
    sra_highlight_para: true, sra_autohide: false, sra_autohide_timeout: 12,
    sra_pin_default: false, sra_debug: false, sra_comprehension: true,
    sra_tts: false, sra_focus_ruler: false, sra_dyslexia: false,
    sra_dyslexia_color: 'rgba(255,243,180,0.12)', sra_bionic: false,
    sra_baseline_wpm: null, sra_dark_mode: false,
    sra_highlight_color: true, sra_highlight_summarize: false,
    sra_highlight_persist: true,
  }, (res) => {
    backendUrl         = res.sra_backend_url || BACKEND_DEFAULT;
    assistantEnabled   = res.sra_enabled !== false;
    selectionEnabled   = res.sra_selection !== false;
    highlightEnabled   = res.sra_highlight_para !== false;
    highlightColorEnabled     = res.sra_highlight_color !== false;
    highlightSummarizeEnabled = !!res.sra_highlight_summarize;
    highlightPersistEnabled   = res.sra_highlight_persist !== false;
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
    if (res.sra_baseline_wpm) comprehensionMonitor.seedWpmFromCalibration(res.sra_baseline_wpm);
    if (dyslexiaEnabled) dyslexiaUtils.applyDyslexiaCSS(dyslexiaColor);
    if (focusRulerEnabled) focusRuler.enable();
    darkModeEnabled = !!res.sra_dark_mode;
    if (darkModeEnabled) applyDarkMode(true);
    settingsLoaded();
  });

  // ── Utilities ──────────────────────────────────────────────────────────
  // esc and clamp live in ui-controller.js, imported above with the rest of it.
  // fetchSummary (item 30a) now lives in host.js — reached here as
  // hostApi.fetchSummary, destructured above as `fetchSummary`.

  // ── Simulated states (testing only) ────────────────────────────────────
  // The panel and these shortcuts speak the engine's vocabulary — on_pace,
  // skimming, struggling, drifting. `simplify` is kept reachable on Alt+2
  // because nothing else exercises that renderer.
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
    const action = forced || SIM_ACTIONS[state] || 'none';

    showSimulateToast(state);
    lastActionAt = 0;
    hostCallbacks.setCogState(state);
    try { chrome.storage.local.set({ sra_current_state: state }); } catch (e) {}

    if (action === 'explain' || action === 'simplify') {
      const para = await hostCallbacks.findParagraphAt(window.innerWidth / 2, window.innerHeight / 2);
      if (para) { hostCallbacks.setCurrentParagraph(para); await triggerAIForParagraph(para, state); }
      else _warn('No paragraph found at viewport centre for simulate');
    } else if (action === 'nudge') {
      const cp = hostCallbacks.getCurrentParagraph();
      const el = cp?.type === 'dom' ? cp.data : null;
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

      // Alt+S: summarise paragraph at viewport centre — the one manual path
      // that reaches pdfHandler/pptxHandler via findParagraphAt() below
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        const para = await hostCallbacks.findParagraphAt(window.innerWidth / 2, window.innerHeight / 2);
        if (para) { hostCallbacks.setCurrentParagraph(para); lastActionAt = 0; await triggerAIForParagraph(para, 'manual'); }
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

      // Alt+C: self-report how reading is going (item 13a, affordance 1) —
      // always reader-initiated, spends no interruption budget. Opens the
      // same standalone card the persistent trigger (affordance 2) does.
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        showSelfReportCard();
        return;
      }
    });
  }


  // Item 30a: fetchQuestions, handleAsk, runSessionRecall and
  // waitForCardToClose now live in host.js — see hostApi.fetchQuestions and
  // hostApi.runSessionRecall (Alt+R / the message listener's 'sessionRecall'
  // action both call the latter). handleAsk backs host.js's own
  // onIntervention 'ask' branch and has no direct call site left here.

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

  // Item 25: which block (by index among the same p/li/blockquote selector
  // paragraph-tracker.js's own scan uses) a highlight's mark sits in. Cheap
  // to compute, and used only as a *secondary* signal at restore time —
  // never to pick a match on its own. Positions shift when ads or images
  // load; the quoted text plus its context is what actually identifies the
  // highlight, this is only a tie-breaker among candidates the text+context
  // check already accepts.
  const HIGHLIGHT_BLOCK_SELECTOR = 'p, li, blockquote';
  function blockIndexOf(node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const block = el?.closest?.(HIGHLIGHT_BLOCK_SELECTOR);
    if (!block) return -1;
    return Array.prototype.indexOf.call(document.querySelectorAll(HIGHLIGHT_BLOCK_SELECTOR), block);
  }

  // Per-document highlight count, matching the existing sra_highlights cap.
  const MAX_HIGHLIGHTS_PER_DOC = 100;
  // Total documents tracked across the whole extension, mirroring
  // coverage-gate.js's MAX_DOCS (150) and sra_last_visit's existing cap —
  // the same shape used everywhere else this codebase keys data per
  // document. Least-recently-touched document (by its highlights' own
  // latest timestamp — the stored shape is { [urlKey]: [...entries] } with
  // no separate per-document metadata, so the entries' own timestamps are
  // the only signal of when a document was last touched) is evicted once
  // this is exceeded.
  const MAX_HIGHLIGHT_DOCS = 150;
  // Item 36: the explanation persisted alongside a highlight. The highlight
  // text itself is capped at 300 chars; the explanation gets a tighter
  // budget — 200 chars, roughly 1-2 sentences, enough to be useful on the
  // Highlights page without dominating storage. This is deliberately
  // shorter than what the transient popup shows (the full fetched summary,
  // unchanged) — the popup is the one-time read, the stored copy is a
  // scannable reminder. Worst case: MAX_HIGHLIGHTS_PER_DOC (100) *
  // MAX_HIGHLIGHT_DOCS (150) = 15,000 highlight entries, each with a
  // 200-char explanation (~400 bytes as UTF-16) plus the ~150-200 bytes
  // already budgeted for text/context/url/title/etc — call it ~550-600
  // bytes/entry total, so roughly 8-9 MB in the pathological case where
  // every single highlight slot in every tracked document has a real,
  // maxed-out explanation. That is far outside any realistic reader's
  // actual use (it requires manually Ctrl+drag-highlighting with this
  // toggle on, one hundred times, on a hundred and fifty separate sites),
  // but it is why the cap is 200 and not the 300 the highlight text gets:
  // the quoted passage is the highlight; the AI's gloss on it is secondary
  // and gets a smaller share of a shared, non-unlimited storage budget.
  const HIGHLIGHT_EXPLANATION_MAX_CHARS = 200;

  // Item 36: patches the explanation onto an already-saved highlight once
  // its assist call resolves — the initial write above already happened by
  // the time this runs (local storage read/write is microtask-fast; the
  // network fetch it waits on is not). Matches by id and re-reads fresh so
  // it is correct regardless of ordering. If the entry is gone by then
  // (deleted by the reader, or evicted by one of the two caps above), this
  // is a silent no-op — there is nothing left to attach the explanation to,
  // and that is not a failure worth surfacing.
  function saveHighlightExplanation(urlKey, hlId, explanation) {
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: hl }) => {
      const entry = (hl[urlKey] || []).find((e) => e.id === hlId);
      if (!entry) return;
      entry.explanation = explanation.slice(0, HIGHLIGHT_EXPLANATION_MAX_CHARS);
      chrome.storage.local.set({ sra_text_highlights: hl });
    });
  }

  async function applyTextHighlight(range, bgColor, colorKey) {
    if (!range || range.collapsed) return;
    const text = range.toString().trim();
    if (!text || text.length > 2000) return; // guard against Ctrl+A

    const hlId = 'sra-hl-' + Date.now();
    const mark  = document.createElement('mark');
    mark.dataset.sraHlId    = hlId;
    mark.dataset.sraHlColor = colorKey;
    mark.style.cssText = `background:${bgColor};border-radius:3px;padding:0 1px;mix-blend-mode:multiply;cursor:default;`;
    mark.title = 'Double-click, or focus and press Delete, to remove this highlight.';

    try {
      range.surroundContents(mark);
    } catch (_) {
      // Selection crosses element boundaries
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }

    mark.addEventListener('dblclick', () => deleteTextHighlight(hlId, mark));
    wireHighlightRemovalAffordance(mark, hlId);

    const urlKey = window.location.hostname + window.location.pathname;

    // "Keep highlights when I leave the page", off by default's opposite —
    // on by default, off means the mark above still renders for this
    // reading session but nothing below this line ever reaches
    // chrome.storage. Not written then deleted on toggle-off; never written
    // in the first place.
    if (highlightPersistEnabled) {
      // Context for restoration — the W3C Web Annotation TextQuoteSelector
      // shape: the exact text plus a short prefix and suffix of surrounding
      // context. This, not position, is the primary anchor at restore time.
      const bodyText = document.body.innerText || '';
      const pos = bodyText.indexOf(text);
      const ctxBefore = pos > 0 ? bodyText.slice(Math.max(0, pos - 40), pos).trim() : '';
      const ctxAfter  = pos >= 0 ? bodyText.slice(pos + text.length, pos + text.length + 40).trim() : '';
      const paragraphIndex = blockIndexOf(mark);

      chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: hl }) => {
        if (!hl[urlKey]) hl[urlKey] = [];
        hl[urlKey].push({
          id: hlId, text: text.slice(0, 300), color: bgColor, colorKey,
          ctxBefore, ctxAfter, paragraphIndex,
          url: window.location.href, title: document.title, timestamp: Date.now(),
        });
        if (hl[urlKey].length > MAX_HIGHLIGHTS_PER_DOC) hl[urlKey].shift();

        const keys = Object.keys(hl);
        if (keys.length > MAX_HIGHLIGHT_DOCS) {
          const lastTouched = (k) => hl[k].reduce((max, e) => Math.max(max, e.timestamp || 0), 0);
          const oldest = keys.reduce((a, b) => (lastTouched(a) <= lastTouched(b) ? a : b));
          if (oldest !== urlKey) delete hl[oldest];
        }

        chrome.storage.local.set({ sra_text_highlights: hl });
      });
    }

    // Item 26: the AI-calling half of "what a highlight does", off by
    // default and independent of the colour toggle above — a reader can
    // want the colour mark without spending an assist on every one of them.
    // Read live at the point of action, not a captured copy, same as every
    // other flag in this file.
    if (highlightSummarizeEnabled) {
      let anchorRect = null;
      try { const r = mark.getBoundingClientRect(); if (r.width || r.height) anchorRect = r; } catch (e) {}
      const mode = isLikelyCode(text) ? 'explain_code' : 'tldr';
      const summary = await fetchSummary(text, mode);
      if (summary) {
        renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text, source: 'highlight', mode });
        // Item 36: persisted alongside the highlight, not just shown once —
        // only meaningful if the highlight itself was persisted above.
        if (highlightPersistEnabled) saveHighlightExplanation(urlKey, hlId, summary);
      }
      // A failed fetch degrades to silence here, same as every other AI call
      // in this file (invariant 9) — the colour mark itself already landed
      // and is not undone by a summary that could not be fetched. No retry:
      // a silent retry would spend an assist the reader never asked for.
    }
  }

  function deleteTextHighlight(hlId, markEl) {
    hideHighlightRemovalChip();
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

  // ── Highlight removal affordance ────────────────────────────────────────
  // Double-click removes a highlight, but nothing on the page ever hinted
  // that. This gives the same removal a discoverable, hover/focus-revealed
  // control that never occupies layout space, plus a keyboard path and a
  // way to find the Highlights page from the highlight itself.
  let _hlChipEl     = null;
  let _hlChipMark   = null;
  let _hlChipHideAt = null;

  function positionHighlightChip(mark) {
    if (!_hlChipEl) return;
    const r = mark.getBoundingClientRect();
    const chipW = _hlChipEl.offsetWidth || 160;
    const chipH = _hlChipEl.offsetHeight || 26;
    const left = Math.min(Math.max(r.left, 4), window.innerWidth - chipW - 4);
    const top  = r.top - chipH - 6 >= 0 ? r.top - chipH - 6 : r.bottom + 6;
    _hlChipEl.style.left = `${left}px`;
    _hlChipEl.style.top  = `${top}px`;
  }

  function hideHighlightRemovalChip() {
    clearTimeout(_hlChipHideAt);
    if (_hlChipEl) { _hlChipEl.remove(); _hlChipEl = null; }
    _hlChipMark = null;
  }

  function scheduleHideHighlightChip() {
    clearTimeout(_hlChipHideAt);
    _hlChipHideAt = setTimeout(hideHighlightRemovalChip, 220);
  }

  function showHighlightRemovalChip(mark, hlId) {
    clearTimeout(_hlChipHideAt);
    if (_hlChipMark === mark && _hlChipEl) { positionHighlightChip(mark); return; }
    hideHighlightRemovalChip();
    _hlChipMark = mark;

    const chip = document.createElement('div');
    chip.id = 'sra-hl-chip';
    Object.assign(chip.style, {
      position: 'fixed', zIndex: '2147483644',
      background: 'white',
      border: '1px solid rgba(0,0,0,0.10)',
      borderRadius: '8px',
      padding: '4px 6px',
      display: 'flex', alignItems: 'center', gap: '8px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.16)',
      fontFamily: "var(--alc-serif, Georgia, serif)",
    });
    chip.addEventListener('mouseenter', () => clearTimeout(_hlChipHideAt));
    chip.addEventListener('mouseleave', scheduleHideHighlightChip);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove highlight';
    removeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:#a33;font-size:11px;padding:2px 4px;white-space:nowrap;';
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTextHighlight(hlId, mark); });
    chip.appendChild(removeBtn);

    const viewLink = document.createElement('a');
    viewLink.href = '#';
    viewLink.textContent = 'All highlights →';
    viewLink.style.cssText = 'color:#888;font-size:10px;text-decoration:underline;cursor:pointer;white-space:nowrap;';
    viewLink.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); highlightsSidebar.open(); });
    chip.appendChild(viewLink);

    document.body.appendChild(chip);
    _hlChipEl = chip;
    positionHighlightChip(mark);
  }

  // Attached to every highlight <mark>, freshly made or restored. Purely
  // additive to the existing dblclick handler — that keeps working exactly
  // as it did.
  function wireHighlightRemovalAffordance(mark, hlId) {
    mark.tabIndex = 0;
    mark.setAttribute('aria-label', 'Highlighted text. Press Delete to remove it, or Enter to open your saved highlights.');

    mark.addEventListener('mouseenter', () => showHighlightRemovalChip(mark, hlId));
    mark.addEventListener('mouseleave', scheduleHideHighlightChip);
    mark.addEventListener('focus', () => showHighlightRemovalChip(mark, hlId));
    mark.addEventListener('blur', scheduleHideHighlightChip);

    mark.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteTextHighlight(hlId, mark);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        highlightsSidebar.open();
      }
    });

    // Touch has no hover — a long-press reveals the same chip so the remove
    // button and the highlights-page link are reachable there too.
    let touchTimer = null;
    const cancelTouch = () => clearTimeout(touchTimer);
    mark.addEventListener('touchstart', () => {
      cancelTouch();
      touchTimer = setTimeout(() => showHighlightRemovalChip(mark, hlId), 500);
    }, { passive: true });
    mark.addEventListener('touchend', cancelTouch);
    mark.addEventListener('touchmove', cancelTouch);
    mark.addEventListener('touchcancel', cancelTouch);
  }

  // The chip is position:fixed against the viewport, so it goes stale the
  // instant the page scrolls under it — hiding beats drawing a control that
  // now points at the wrong text.
  window.addEventListener('scroll', () => { if (_hlChipEl) hideHighlightRemovalChip(); }, { passive: true, capture: true });

  function restoreTextHighlights() {
    const urlKey = window.location.hostname + window.location.pathname;
    chrome.storage.local.get({ sra_text_highlights: {} }, ({ sra_text_highlights: hl }) => {
      const saved = hl[urlKey] || [];
      if (saved.length) saved.forEach(entry => { try { restoreSingleHighlight(entry); } catch (_) {} });
      scrollToRequestedHighlight();
    });
  }

  // Must match HIGHLIGHT_ANCHOR_PARAM in src/shared/highlights-render.js —
  // that is the module that appends this to a highlight card's link.
  const HIGHLIGHT_ANCHOR_PARAM = 'sra_hl';

  // Clicking a highlight in the Highlights page/sidebar opens its source
  // with ?sra_hl=<id> appended, so a reader lands on the article and not
  // just at the top of it — this is what actually gets them to the exact
  // spot. Silent no-op if the mark cannot be found: the anchoring above
  // already abstains rather than guess when the text is gone, and a scroll
  // target that does not exist is the same case.
  function scrollToRequestedHighlight() {
    let hlId;
    try { hlId = new URL(window.location.href).searchParams.get(HIGHLIGHT_ANCHOR_PARAM); } catch (_) { return; }
    if (!hlId) return;
    const mark = document.querySelector(`mark[data-sra-hl-id="${CSS.escape(hlId)}"]`);
    if (!mark) return;
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.add('sra-nudge-highlight');
    setTimeout(() => mark.classList.remove('sra-nudge-highlight'), 3000);
  }

  /* Quote-based anchoring (W3C TextQuoteSelector shape): find every place
   * the exact highlighted text still occurs, score each by how well the
   * stored prefix/suffix context matches around it, and only fall back to
   * the stored paragraphIndex as a *tie-breaker* among candidates the
   * context already accepts — never to pick a match on its own. If nothing
   * has any context confirmation at all (a repeated short phrase with no
   * matching surroundings anywhere), this refuses to guess and leaves the
   * entry in storage untouched: attaching a reader's highlight to text they
   * did not highlight is worse than not showing it. */
  function restoreSingleHighlight({ id: hlId, text, color, ctxBefore, ctxAfter, paragraphIndex }) {
    if (!text || text.length < 2) return;

    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const tag = node.parentElement?.tagName?.toUpperCase?.();
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'MARK'].includes(tag)) continue;
      let from = 0, idx;
      while ((idx = node.textContent.indexOf(text, from)) !== -1) {
        candidates.push({ node, idx });
        from = idx + 1;
      }
    }
    if (!candidates.length) return; // text is gone — fail silently, stays in storage

    const contextScore = ({ node, idx }) => {
      const pre  = node.textContent.slice(0, idx).trim().slice(-40);
      const post = node.textContent.slice(idx + text.length).trim().slice(0, 40);
      let score = 0;
      if (ctxBefore && ctxBefore.length > 4 && (pre.endsWith(ctxBefore.slice(-20)) || ctxBefore.endsWith(pre.slice(-8)))) score += 2;
      if (ctxAfter && ctxAfter.length > 4 && (post.startsWith(ctxAfter.slice(0, 20)) || ctxAfter.startsWith(post.slice(0, 8)))) score += 2;
      return score;
    };

    let winner = null;
    if (candidates.length === 1) {
      winner = candidates[0];
    } else {
      const scored = candidates
        .map((c) => ({ ...c, score: contextScore(c) }))
        .filter((c) => c.score > 0);
      if (scored.length === 1) {
        winner = scored[0];
      } else if (scored.length > 1) {
        // Position is only consulted among candidates context already
        // confirmed, and only to break ties between equally-confirmed ones.
        scored.sort((a, b) => (b.score - a.score)
          || ((Number.isInteger(paragraphIndex) ? Math.abs(blockIndexOf(a.node) - paragraphIndex) : Infinity)
            - (Number.isInteger(paragraphIndex) ? Math.abs(blockIndexOf(b.node) - paragraphIndex) : Infinity)));
        winner = scored[0];
      }
      // scored.length === 0: multiple identical-text candidates, none with
      // any matching context — genuinely ambiguous. Abstain.
    }
    if (!winner) return;

    const { node: winnerNode, idx } = winner;
    const range = document.createRange();
    range.setStart(winnerNode, idx);
    range.setEnd(winnerNode, Math.min(idx + text.length, winnerNode.textContent.length));

    const mark = document.createElement('mark');
    mark.dataset.sraHlId = hlId;
    mark.style.cssText = `background:${color};border-radius:3px;padding:0 1px;mix-blend-mode:multiply;cursor:default;`;
    mark.title = 'Double-click, or focus and press Delete, to remove this highlight.';
    mark.addEventListener('dblclick', () => deleteTextHighlight(hlId, mark));
    wireHighlightRemovalAffordance(mark, hlId);

    try {
      range.surroundContents(mark);
    } catch (_) {
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
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

    // Ctrl/Cmd + drag → colour highlight and/or an AI summary, per the two
    // independent item-26 toggles (never the plain-selection summary toggle
    // below — a reader can want either of these without the other):
    //   colour on,  summarize on/off → the existing colour-picker flow;
    //     applyTextHighlight() itself checks highlightSummarizeEnabled once
    //     a swatch is actually picked.
    //   colour off, summarize on     → no picker, no mark; summarise the
    //     selection directly (the rejected four-way design's "summary only").
    //   colour off, summarize off    → Ctrl+drag does nothing.
    if (ev.ctrlKey || ev.metaKey) {
      if (!highlightColorEnabled && !highlightSummarizeEnabled) return;
      let selRange = null;
      let selText  = '';
      try {
        const sel = window.getSelection();
        selText = sel?.toString().trim() || '';
        if (selText.length >= MIN_SELECTION_CHARS && sel.rangeCount > 0) {
          selRange = sel.getRangeAt(0).cloneRange();
        }
      } catch (e) {}
      if (!selRange) return;

      if (highlightColorEnabled) {
        removeColorPicker();
        showColorPicker(selRange, ev.clientX, ev.clientY);
      } else {
        let anchorRect = null;
        try { const r = selRange.getBoundingClientRect(); if (r.width || r.height) anchorRect = r; } catch (e) {}
        if (!anchorRect) anchorRect = { left: ev.clientX, right: ev.clientX + 8, top: ev.clientY, bottom: ev.clientY + 8 };
        const mode = isLikelyCode(selText) ? 'explain_code' : 'tldr';
        const summary = await fetchSummary(selText, mode);
        if (summary) renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text: selText, source: 'highlight', mode });
      }
      return;
    }

    if (!selectionEnabled) return;

    let selected = '';
    let selRange  = null;
    try {
      const sel = window.getSelection();
      selected  = sel?.toString().trim() || '';
      if (sel?.rangeCount > 0) selRange = sel.getRangeAt(0).cloneRange();
    } catch (e) {}
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

  // Item 30a: findParagraphAt now lives in host.js — one of orchestrator.js's
  // 12 callbacks — reached here as hostCallbacks.findParagraphAt(). It still
  // checks pdfHandler/pptxHandler first, but only whichever host.js was
  // handed via setPdfHandler()/setPptxHandler() below, in detectAndInitHandlers().

  // ── Summarise/explain a paragraph (simulate path, manual Alt+S) ────────
  async function triggerAIForParagraph(paraInfo, reason) {
    if (!paraInfo) return;

    let text = '', el = null;
    try {
      if (paraInfo.type === 'dom') { el = paraInfo.data; text = (el?.innerText || el?.textContent || '').trim(); }
      else if (paraInfo.type === 'pdf')  text = await pdfHandler.getParagraphText(paraInfo.data);
      else if (paraInfo.type === 'pptx') text = await pptxHandler.getParagraphText(paraInfo.data);
    } catch (e) {
      // Extraction failure — PDF.js choking on a hostile file, a PPTX slide
      // with no text layer, whatever it is. Falls through to the empty-text
      // check below exactly like a page with nothing extractable at all.
      text = '';
    }
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
      const summary = await fetchSummary(text, mode, getPrevParagraphText());
      if (!summary) return;
      renderPopup(anchorRect, `<div>${esc(summary)}</div>`, { text, source:'reading', trigger:reason, triggerLabel });
      saveHighlight(text, summary, reason);
      sessionTracker.recordSignal('cognitive', reason, text.slice(0, 150));
      readingMap.recordEvent(reason, text.slice(0, 40));
    } finally {
      if (_fp) inFlightFingerprints.delete(_fp);
    }
  }

  // ── PDF/PPTX handlers ─────────────────────────────────────────────────
  async function detectAndInitHandlers() {
    const url = window.location.href;
    if (/\.pdf($|[?#])/i.test(url) || document.querySelector('embed[type="application/pdf"]')) {
      try { const m = await loadModule('src/content/pdf-handler.js'); pdfHandler = await m.initPDFHandler(); setPdfHandler(pdfHandler); } catch(e) {_warn('PDF:',e);}
    }
    if (/\.pptx($|[?#])/i.test(url) || document.querySelector('a[href$=".pptx"]')) {
      try { const m = await loadModule('src/content/pptx-handler.js'); pptxHandler = await m.initPPTXHandler(); setPptxHandler(pptxHandler); } catch(e) {_warn('PPTX:',e);}
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.sra = window.sra || {};
  window.sra.getState = () => getCogState();

  // ── Message listener ───────────────────────────────────────────────────
  // Deliberately NOT `async (msg, _, sendResponse) => {...}`. Chrome decides
  // whether to keep the message channel open for an async sendResponse by
  // checking whether the listener's *synchronous* return value is the
  // literal boolean `true` — an async function always returns a Promise
  // instead, even when its body does `return true` with nothing awaited
  // first, so Chrome never sees `true` and can close the channel before an
  // inner `(async () => { ...; sendResponse(...); })()` IIFE gets to call
  // sendResponse. Found via real chrome.tabs.sendMessage testing (item 16's
  // browser smoke check): "The message port closed before a response was
  // received." on checkQuizCoverage, which is the first handler here ever
  // exercised through an actual cross-context sendMessage rather than a
  // same-page keyboard shortcut. Every branch below already returns `true`
  // correctly; the outer function just has to stop hiding it inside a Promise.
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    // Every branch below keys on either `msg.type` (settings, calibration,
    // simulateState) or `msg.action` (sessionRecall, showReceipt,
    // recallStats, checkQuizCoverage) — two conventions that grew up side
    // by side in this file. Requiring `.type` here silently discarded every
    // `.action`-only message before it ever reached its branch: popup.js's
    // recallBtn and receiptBtn (both send `{ action: ... }` via sendToTab)
    // would flash their busy label and revert with nothing happening,
    // because Chrome closes the message channel — "port closed before a
    // response was received" — the instant this function returns
    // `undefined` instead of `true`. Found via item 16's browser smoke
    // check, the first real chrome.tabs.sendMessage call any `.action`
    // branch here had ever been exercised by; keyboard shortcuts (Alt+R,
    // Alt+I) reach the same features through a same-page function call
    // instead and never touched this listener at all.
    if (!msg?.type && !msg?.action) return;

    if (msg.type === 'settings') {
      if (msg.selection     !== undefined) selectionEnabled   = !!msg.selection;
      if (msg.highlightPara !== undefined) highlightEnabled   = !!msg.highlightPara;
      if (msg.highlightColor     !== undefined) highlightColorEnabled     = !!msg.highlightColor;
      if (msg.highlightSummarize !== undefined) highlightSummarizeEnabled = !!msg.highlightSummarize;
      if (msg.highlightPersist   !== undefined) highlightPersistEnabled   = !!msg.highlightPersist;
      if (msg.autohide      !== undefined) autohideEnabled    = !!msg.autohide;
      if (msg.autohideTimeout !== undefined) autohideTimeoutSec = Number(msg.autohideTimeout) || 12;
      if (msg.pinDefault    !== undefined) pinDefault         = !!msg.pinDefault;
      if (msg.debug         !== undefined) debugEnabled       = !!msg.debug;
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
      sendResponse({ status: 'ok' }); return;
    }
    if (msg.type === 'debugToggle') {
      debugEnabled = !!msg.enabled;
      sendResponse({ status:'ok' }); return true;
    }
    // Item 27: background.js's webNavigation.onHistoryStateUpdated listener
    // — the channel that actually reaches a real SPA's pushState-driven
    // route change, unlike the isolated-world history patch below.
    if (msg.type === 'spaRouteChanged') {
      try { onSpaNavigate(); } catch (e) {}
      sendResponse({ status: 'ok' }); return true;
    }
    if (msg.type === 'startReadingCalibration') {
      (async () => {
        try {
          const result = await runSelfPacedCalibration({
            onComplete: (success, wpm) => {
              _log('Reading calibration complete, success:', success, 'wpm:', wpm);
              // Seed comprehension monitor's WPM baseline and persist it —
              // it used to be written only inside a gaze-feature-baseline
              // branch, so a reader who had just sat there measuring lost
              // the number the moment the page unloaded.
              if (success && wpm) {
                comprehensionMonitor.seedWpmFromCalibration(wpm);
                chrome.storage.local.set({ sra_baseline_wpm: wpm });
              }
            }
          });
          sendResponse({ status: 'ok', result });
        } catch (e) {
          sendResponse({ status: 'error', error: String(e) });
        }
      })();
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
    if (msg.action === 'openHighlightsSidebar') {
      highlightsSidebar.toggle();
      sendResponse({ status: 'ok' });
      return true;
    }
    if (msg.action === 'recallStats') {
      sendResponse({ status: 'ok', stats: sessionRecall.stats() });
      return true;
    }
    if (msg.action === 'checkQuizCoverage') {
      // The popup's quiz button and the end-of-reading offer must read the
      // same threshold from the same function (CLAUDE.md, "The quiz —
      // decided") — this is that function, reached from the popup context.
      (async () => {
        try {
          const key = orchestrator.documentKey();
          const result = key
            ? await orchestrator.coverageGate.evaluate(key)
            : { ready: false, reason: 'not enough reading tracked on this page yet', coveragePct: null, dwellMs: 0 };
          sendResponse({ status: 'ok', key, ...result });
        } catch (e) {
          sendResponse({ status: 'ok', key: null, ready: false, reason: 'not enough reading tracked on this page yet', coveragePct: null, dwellMs: 0 });
        }
      })();
      return true;
    }
    if (msg.action === 'startQuiz') {
      // From the popup's "Take the quiz" button — same generation path
      // (runQuiz) the end-of-reading offer's own button calls, so there is
      // exactly one place that selects passages and makes the one server
      // call, not a second copy per entry point.
      (async () => {
        try {
          const ok = await runQuiz();
          sendResponse({ status: 'ok', started: ok });
        } catch (e) {
          sendResponse({ status: 'ok', started: false });
        }
      })();
      return true;
    }
    if (msg.action === 'getSnoozeStatus') {
      (async () => {
        try {
          const until = await snoozeControl.until();
          sendResponse({ status: 'ok', active: until > Date.now(), until });
        } catch (e) {
          sendResponse({ status: 'ok', active: false, until: 0 });
        }
      })();
      return true;
    }
    if (msg.action === 'snoozeReminders') {
      // From the popup — the card's own snooze control calls startSnooze()
      // directly in the same page. popup.js sends only an option id, not a
      // computed duration: the duration math (SNOOZE_OPTIONS, "rest of
      // today") stays canonical in snooze.js and is resolved here, the same
      // place question-card.js resolves it, rather than a second copy
      // running in the popup's own timezone/clock context. No "current
      // card" to dismiss here, so the dismissal for item 10's backoff is
      // recorded explicitly instead of riding along on question-card.js's
      // dismiss() path.
      (async () => {
        try {
          const opt = SNOOZE_OPTIONS.find((o) => o.id === msg.optionId);
          if (!opt) { sendResponse({ status: 'error' }); return; }
          const until = await startSnooze(opt.durationMs(Date.now()), opt.label);
          try { orchestrator.interventionPolicy.recordDismissal(); } catch (e) {}
          sendResponse({ status: 'ok', until });
        } catch (e) {
          sendResponse({ status: 'error' });
        }
      })();
      return true;
    }
    if (msg.action === 'cancelSnooze') {
      (async () => {
        await snoozeControl.cancel();
        sendResponse({ status: 'ok' });
      })();
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
      sendResponse({ state: getCogState() });
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
  // Item 27: two independent channels can call this — the pushState/
  // replaceState patch below (which only ever actually fires on a genuine
  // popstate, since the patch itself never sees a page-context pushState
  // call — see the header comment on the patch) and background.js's
  // webNavigation-driven 'spaRouteChanged' message (the one that reaches
  // real SPA route changes). Both are safe to call for the same navigation:
  // lastSpaDocKey makes the second call a no-op on the route-change-reset
  // front, since documentKey() will already match.
  let lastSpaDocKey = null;
  function onSpaNavigate() {
    // A query-string-only or hash-only change is the same document per
    // coverage-gate.js's own documentKey() (hostname+pathname, no search, no
    // hash) — only a pathname change is a genuine new document and should
    // reset paragraph tracking. A same-document popup/highlight refresh
    // still runs either way; it is cheap and was already unconditional.
    const newKey = orchestrator ? orchestrator.documentKey() : null;
    const isRouteChange = !!newKey && newKey !== lastSpaDocKey;
    lastSpaDocKey = newKey;

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

    // Item 27: paragraph tracking, the comprehension monitor's in-flight
    // paragraph, and the paragraph-index-keyed signal detectors all
    // belong to the DOM of the document that just disappeared. Only a real
    // pathname change warrants this — see orchestrator.js's
    // handleRouteChange() header for the full reasoning.
    if (isRouteChange) {
      try { orchestrator.handleRouteChange(); } catch (e) {}
    }

    // Item 25: colour highlights are keyed per document (hostname+pathname),
    // and used to only ever restore once, at initial page load — so an SPA
    // route change never brought back highlights for the new route without
    // a full reload. restoreTextHighlights() re-reads window.location at
    // call time, so it naturally picks up the new URL's key; the short
    // delay gives the SPA framework a chance to actually render the new
    // route's content first; restoreSingleHighlight() already fails silently
    // on unmatched text, so a still-mid-transition DOM just yields no match
    // rather than a wrong one.
    setTimeout(restoreTextHighlights, 300);
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
          lastCogState: getCogState(), timestamp: Date.now(),
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
  await settingsReady;

  /* Turning the switch off has to leave the page as if the extension were
   * not installed: no cards, no ruler, no sidebar, no speech, and no
   * signals accruing in the background. Turning it back on resumes
   * whatever the reader's settings already said. */
  function setAssistantEnabled(on) {
    const was = assistantEnabled;
    assistantEnabled = !!on;
    if (was === assistantEnabled) return;

    if (!assistantEnabled) {
      try { hidePopup(true); } catch (e) { /* nothing open */ }
      try { ui.clearHighlight(); } catch (e) { /* nothing highlighted */ }
      try { focusRuler.disable(); } catch (e) { /* never enabled */ }
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
  // Baseline for onSpaNavigate()'s route-change check — set once, here,
  // rather than left at its `null` default, so the first real navigation is
  // correctly compared against the page the content script actually loaded
  // on rather than treated as a route change against nothing.
  lastSpaDocKey = orchestrator.documentKey();

  restoreHighlightMarkers();
  restoreTextHighlights();
  checkLastVisit();
  window.addEventListener('beforeunload', () => {
    try { sessionTracker.save(); } catch (e) {}
    // Item DC-1a. hostApi.submitKinematics is always a no-op on an ordinary
    // page (content.js never constructs a host with assignmentId/getSession
    // — see host.js's own header) — called unconditionally anyway, the same
    // way submitOutcome's gate is trusted rather than duplicated at each
    // call site. shouldSubmitKinematics() (kinematics.js) owns the 30s
    // floor, shared with viewer.js's identical beforeunload hook.
    try {
      const durationMs = sessionTracker.snapshot().durationMs;
      const kinematics = orchestrator?.kinematicsSummary?.();
      if (kinematicsModule.shouldSubmitKinematics({ durationMs, kinematics })) {
        hostApi.submitKinematics({ ...kinematics, duration_ms: durationMs });
      }
    } catch (e) {}
    saveLastVisit();
  });

  _log('Content script loaded ✓');

})();
} // end __sra_main