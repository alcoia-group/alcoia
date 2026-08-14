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
  // Session-level cache: mode:fingerprint → summary text (cleared on page unload)
  const _summaryCache        = new Map();

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
  let comprehensionCheckEnabled = true;

  // ── New feature flags ──────────────────────────────────────────────────
  let ttsEnabled          = false;
  let focusRulerEnabled   = false;
  let darkModeEnabled     = false;
  let dyslexiaEnabled     = false;
  let dyslexiaColor       = 'rgba(255,243,180,0.12)';
  let bionicEnabled       = false;
  let prevParagraphText   = '';    // for AI context window

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
  // Loaded here, not from background.js: install-token.js is a real ES
  // module, and Chrome disallows dynamic import() from inside a service
  // worker outright. Content scripts have no such restriction. background.js
  // stays a dumb relay that requires a token to already be attached — see
  // its 'summarize'/'apiPost' handler and install-token.js's own header.
  const installTokenModule = await loadModule('src/shared/install-token.js');
  const installToken = installTokenModule.createInstallTokenManager({
    tokenUrl: self.ALCOIA_CONFIG.TOKEN_URL,
  });
  // Every failure here already degrades to silence for the reader
  // (invariant 9) — this only makes that silence inspectable afterward, on
  // the diagnostics page. Never fed passage text, a URL or a page title;
  // see diag-log.js's own header for why.
  const diagLogModule = await loadModule('src/shared/diag-log.js');
  const diagLog = diagLogModule.createDiagLog();
  // Same origin as wherever the AI call is actually going — a developer who
  // pointed the popup's Backend URL setting at a local server gets their
  // token from that same server, not the shipped default.
  const tokenUrl = () => {
    try { return new URL('/api/token', backendUrl || BACKEND_DEFAULT).href; }
    catch (e) { return self.ALCOIA_CONFIG.TOKEN_URL; }
  };
  // Every AI request goes through here: resolve the token, attach it, relay
  // the background worker's response. `ok:false` covers every failure this
  // item's brief lists — unreachable, non-ok, malformed, or simply no token
  // yet — and every caller below already treats an ok:false/falsy result as
  // "nothing to show", so no separate error UI is needed on top of this.
  async function callBackend(action, url, body) {
    const token = await installToken.getToken(tokenUrl());
    if (!token) { diagLog.log(action, 'no_install_token'); return { ok: false, error: 'no_install_token' }; }
    return await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action, url, body, token }, (resp) => {
          if (chrome.runtime.lastError || !resp) { diagLog.log(action, 'no_response'); resolve({ ok: false, error: 'no_response' }); return; }
          if (resp.tokenRejected) {
            installToken.invalidate();
            diagLog.log(action, `token_rejected_${resp.status}`);
          } else if (!resp.ok) {
            diagLog.log(action, resp.error || `status_${resp.status}`);
          }
          resolve(resp);
        });
      } catch (e) { diagLog.log(action, String(e && e.message || e)); resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }

  const overlayUtils = await loadModule('src/content/overlay-utils.js');
  const compModule  = await loadModule('src/content/comprehension-monitor.js');
  const readCalModule = await loadModule('src/content/reading-calibration.js');
  const { runSelfPacedCalibration } = readCalModule;
  const ttsModule      = await loadModule('src/content/tts-handler.js');
  const rulerModule    = await loadModule('src/content/focus-ruler.js');
  const dyslexiaModule  = await loadModule('src/content/dyslexia-utils.js');
  const segmentation     = await loadModule('src/content/signals/segmentation.js');
  const mapModule       = await loadModule('src/content/reading-map.js');

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
    renderPopup, reservePopup, showPopup,
    showNudge, showSimulateToast, showStatusToast,
  } = ui;

  // ── Snooze (item 18) ─────────────────────────────────────────────────────
  const snoozeModule = await loadModule('src/content/snooze.js');
  const snoozeControl = snoozeModule.createSnoozeControl();

  // ── Question layer ─────────────────────────────────────────────────────
  const responseModule = await loadModule('src/content/signals/response-signals.js');
  const cardModule     = await loadModule('src/content/question-card.js');
  const responseSignals = responseModule.createResponseSignals();
  const recallModule = await loadModule('src/content/signals/session-recall.js');
  const sessionRecall = recallModule.createSessionRecall();

  // ── Receipt ────────────────────────────────────────────────────────────
  // Reader-generated only. Nothing below runs on a timer, and nothing leaves
  // the machine without a click in the preview panel.
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

  // Opens the quiz page in a new tab. Content scripts cannot call
  // chrome.tabs.create directly — relayed through background.js's existing
  // 'openTab' handler, the same one popup.js's notes/highlights/etc. use via
  // chrome.tabs.create itself (an extension page can call it directly; a
  // content script cannot, hence the relay only here).
  function openQuizPage(key) {
    const url = chrome.runtime.getURL('src/popup/quiz.html') + (key ? '?key=' + encodeURIComponent(key) : '');
    try { chrome.runtime.sendMessage({ action: 'openTab', url }); } catch (e) {}
  }

  /* the project notes: "5-8 questions... one server call per quiz... one passage
   * batch in, N questions out." session-recall.js's weighted select() picks
   * the paragraphs; they are joined into ONE passage and sent in ONE
   * fetchQuestions() call with count set to the top of the range — the
   * existing /api/questions contract already accepts a count, so this reuses
   * it rather than inventing a batch endpoint the server does not have.
   * `clampCount` in the server's own question-validation contract caps count
   * at 5 today (see tests/contract/questions.js), so a real deployment may
   * return fewer than 8 even when asked for more; nothing here assumes a
   * specific number back, only a minimum worth showing as a quiz. */
  const QUIZ_TARGET_COUNT = 8;
  const QUIZ_MIN_QUESTIONS = 5;
  let quizGenerating = false;

  /* Selects, generates and stashes a quiz for the current document, then
   * opens the quiz page to pick it up. Returns true only if a quiz was
   * actually produced — the caller (the offer card, or the popup via
   * startQuiz) uses that to show or not show a busy/failure state. Nothing
   * here writes passage text to disk: the joined text lives only in this
   * function's memory and in the one outgoing request body. */
  async function runQuiz() {
    if (quizGenerating) return false;
    const key = orchestrator.documentKey();
    if (!key) return false;

    quizGenerating = true;
    try {
      const picked = sessionRecall.select(QUIZ_TARGET_COUNT);
      if (!picked.length) return false;

      const combinedText = picked.map((p) => p.text).join('\n\n');
      const questions = await fetchQuestions(combinedText, { count: QUIZ_TARGET_COUNT, kind: 'recall' });
      // Fewer than the floor is a generation failure, not a shorter quiz —
      // invariant 9's "a wrong intervention is worse than a missed one"
      // extends here as "no quiz is better than a thin, unrepresentative one".
      if (questions.length < QUIZ_MIN_QUESTIONS) return false;

      await new Promise((resolve) => chrome.storage.local.set({
        sra_quiz_pending: { key, questions: questions.slice(0, QUIZ_TARGET_COUNT), createdAt: Date.now() },
      }, resolve));

      openQuizPage(key);
      return true;
    } catch (e) {
      return false;
    } finally {
      quizGenerating = false;
    }
  }

  /* The unprompted end-of-reading offer. Reader-initiated once shown — no
   * interruption budget was spent to put it on screen (quiz-offer.js never
   * touches intervention-policy.js) and none is spent by dismissing it. */
  function showQuizOffer(result) {
    if (!assistantEnabled) return;
    const fingerprint = 'quiz-offer-' + (result.key || 'doc');
    const root = reservePopup(fingerprint);
    if (!root) return;

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn sra-close-btn" title="Dismiss">✕</button>
      </div>
      <div class="sra-popup-body">
        <div class="sra-state-badge sra-q-badge">quiz</div>
        <div class="sra-q-text">Ready to test what you remember?</div>
      </div>
      <div class="sra-popup-divider"></div>
      <div class="sra-actions">
        <button class="sra-btn sra-btn-primary sra-quiz-start-btn">Take the quiz</button>
        <button class="sra-btn sra-btn-secondary sra-q-skip">Not now</button>
      </div>`;

    const dismiss = () => closePopup(root, fingerprint);
    root.querySelector('.sra-close-btn').onclick = dismiss;
    root.querySelector('.sra-q-skip').onclick = dismiss;
    root.querySelector('.sra-quiz-start-btn').onclick = async () => {
      const btn = root.querySelector('.sra-quiz-start-btn');
      btn.disabled = true;
      btn.textContent = 'Preparing…';
      const ok = await runQuiz();
      if (!ok) { btn.disabled = false; btn.textContent = 'Take the quiz'; return; }
      dismiss();
    };

    showPopup(root, null);
  }
  const questionCard = cardModule.createQuestionCard({
    ui,
    esc,
    responseSignals,
    // Scoped to the sentence the reader missed, not the whole paragraph.
    fetchExplanation: (spanText) => fetchSummary(spanText, 'explain_more'),
    onAnswered: (record) => {
      // An answer outranks every other signal — see state-engine.js.
      try { orchestrator.pumpSignals(record); } catch (e) {}
      try { sessionTracker.recordSignal('response', record.subtype, record.span || ''); } catch (e) {}
      // A paragraph already answered correctly is a poor use of a recall slot.
      if (record.paragraphKey) sessionRecall.recordAnswered(record.paragraphKey, record.correct);
      // Any answer — right or wrong — is engagement, which is what clears
      // the dismissal backoff below.
      try { orchestrator.interventionPolicy.recordAnswered(); } catch (e) {}
    },
    onDismissed: () => {
      // Declining to be tested says nothing about comprehension, and is
      // never scored — but it is still the reader saying "not now", and
      // three in a row raises the bar on further questions. See
      // intervention-policy.js's dismissalBackoff.
      try { orchestrator.interventionPolicy.recordDismissal(); } catch (e) {}
    },
    onSnooze: (durationMs, label) => { startSnooze(durationMs, label); },
  });

  /* Shared by the card's own snooze control and the popup's. Recording the
   * dismissal for a popup-triggered snooze happens at the message handler,
   * not here — from the card, dismiss() (called right after this) already
   * records it, and doing it twice would double-count one snooze as two
   * consecutive dismissals toward item 10's backoff. */
  async function startSnooze(durationMs, label) {
    const until = await snoozeControl.snooze(durationMs);
    showStatusToast(`Snoozed${label ? ' for ' + label : ''} — reminders paused`);
    return until;
  }

  // ── Detection pipeline ─────────────────────────────────────────────────
  // orchestrator.js owns the detectors, the state engine and the interruption
  // budget. It decides; this file renders. onIntervention returns whether
  // anything actually reached the screen, and the budget is spent only on a
  // yes — an offer that bails out here must not burn one of the reader's five.
  const orchModule = await loadModule('src/content/orchestrator.js');
  orchestrator = await orchModule.createOrchestrator({
    loadModule,
    comprehensionMonitor,
    // Read live: the storage listener reassigns these at runtime.
    settings: () => ({
      assistantEnabled,
      comprehensionCheckEnabled, focusRulerEnabled,
      debugEnabled,
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
      onParagraphRead: (text, dwellMs) => sessionRecall.recordRead(text, dwellMs),
      onStruggle: (text) => sessionRecall.recordStruggle(text),
      onQuizOfferEligible: (result) => showQuizOffer(result),
      onIntervention: async (decision, state, target) => {
        // Off means off: nothing reaches the screen, and the budget is not
        // spent on an offer that was never made.
        if (!assistantEnabled) return false;
        // Item 18: only the final render is suppressed. Detection, coverage
        // tracking and the quiz gate all keep running above this — pausing
        // those too would mean a reader who snoozes never reaches the quiz
        // gate, which is a worse outcome than a paused reminder.
        if (await snoozeControl.isActive()) return false;
        if (decision.action === 'nudge') {
          showNudge(target);
          if (target) highlightElement(target, 3000);
          return true;
        }
        if (decision.action === 'ask') {
          return await handleAsk(decision, state, target);
        }
        // intervention-policy.js's STATE_ACTIONS only ever produces 'ask' or
        // 'nudge' for an allowed decision — 'none' is denied before this is
        // ever called — so there is no third branch to fall through to here.
        return false;
      },
    },
  });

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
  }, (res) => {
    backendUrl         = res.sra_backend_url || BACKEND_DEFAULT;
    assistantEnabled   = res.sra_enabled !== false;
    selectionEnabled   = res.sra_selection !== false;
    highlightEnabled   = res.sra_highlight_para !== false;
    highlightColorEnabled     = res.sra_highlight_color !== false;
    highlightSummarizeEnabled = !!res.sra_highlight_summarize;
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
      // the extension only. callBackend() attaches the install token and
      // relays whatever background.js returns.
      const resp = await callBackend('summarize', url, body);
      if (!resp.ok) { _warn(`Server ${resp.status || ''} ${resp.error || ''}`); return null; }
      const j = resp.data;
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

      // Alt+S: summarise paragraph at viewport centre — the one manual path
      // that reaches pdfHandler/pptxHandler via findParagraphAt() below
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
    const resp = await callBackend('apiPost', questionsUrl(), body);
    if (!resp.ok) {
      // 422 means nothing passed the server's citation check; 503 means no
      // key; no_install_token means the token couldn't be resolved. All are
      // ordinary failure outcomes and all degrade to silence — see
      // handleAsk(), which treats an empty result as nothing to show rather
      // than falling back to an explanation.
      _log(`Questions unavailable (${resp.status || resp.error || 'error'})`);
      return [];
    }
    const j = resp.data;
    if (!j) return [];
    return Array.isArray(j.questions) ? j.questions : [];
  }

  /* Returns true only if a card reached the screen. */
  async function handleAsk(decision, state, target) {
    const el = target || (currentParagraph?.type === 'dom' ? currentParagraph.data : null);
    const text = el ? (el.innerText || el.textContent || '').trim() : (state.signal?.text || '');
    if (!text) return false;

    // Every way this can come back empty — network failure, a non-ok status
    // (422 nothing passed the server's citation check, 503 no key), a
    // malformed response, or a genuine empty result — collapses to the same
    // outcome here: silence. This used to fall back to a comprehension-offer
    // popup or a summary, which meant a failed *question* call quietly
    // became a shown *explanation*, on a product whose whole premise is that
    // asking beats summarising. A wrong intervention is worse than a missed
    // one (invariant 9) — nothing reaches the screen and the caller does not
    // spend the interruption budget on an offer that was never made.
    const questions = await fetchQuestions(text);
    if (!questions.length) return false;

    let anchorRect = null;
    try { if (el) anchorRect = el.getBoundingClientRect(); } catch (e) {}
    if (el) highlightElement(el, 4000);

    return questionCard.show(questions[0], {
      evidence: decision.evidence,
      anchorRect,
      paragraphKey: text.slice(0, 80).trim(),
      wasExplorationSample: decision.wasExplorationSample === true,
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

  async function applyTextHighlight(range, bgColor, colorKey) {
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

    // Context for restoration — the W3C Web Annotation TextQuoteSelector
    // shape: the exact text plus a short prefix and suffix of surrounding
    // context. This, not position, is the primary anchor at restore time.
    const bodyText = document.body.innerText || '';
    const pos = bodyText.indexOf(text);
    const ctxBefore = pos > 0 ? bodyText.slice(Math.max(0, pos - 40), pos).trim() : '';
    const ctxAfter  = pos >= 0 ? bodyText.slice(pos + text.length, pos + text.length + 40).trim() : '';
    const paragraphIndex = blockIndexOf(mark);

    const urlKey = window.location.hostname + window.location.pathname;
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
      }
      // A failed fetch degrades to silence here, same as every other AI call
      // in this file (invariant 9) — the colour mark itself already landed
      // and is not undone by a summary that could not be fetched.
    }
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
    mark.title = 'Double-click to remove highlight';
    mark.addEventListener('dblclick', () => deleteTextHighlight(hlId, mark));

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

  // ── Paragraph finder ───────────────────────────────────────────────────
  async function findParagraphAt(cx, cy) {
    if (pdfHandler?.findParagraphAt)  { const p = await pdfHandler.findParagraphAt(cx,cy);  if(p) return {type:'pdf', data:p}; }
    if (pptxHandler?.findParagraphAt) { const p = await pptxHandler.findParagraphAt(cx,cy); if(p) return {type:'pptx',data:p}; }
    const el = document.elementFromPoint(cx, cy);
    if (!el) return null;
    return { type: 'dom', data: overlayUtils.getBlockAncestor(el) || el };
  }

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
  window.sra.getState = () => lastCogState;

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
    if (msg.action === 'recallStats') {
      sendResponse({ status: 'ok', stats: sessionRecall.stats() });
      return true;
    }
    if (msg.action === 'checkQuizCoverage') {
      // The popup's quiz button and the end-of-reading offer must read the
      // same threshold from the same function (the project notes, "The quiz —
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
          const opt = snoozeModule.SNOOZE_OPTIONS.find((o) => o.id === msg.optionId);
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
      sendResponse({ state: lastCogState });
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
    saveLastVisit();
  });

  _log('Content script loaded ✓');

})();
} // end __sra_main