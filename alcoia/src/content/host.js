/* host.js — the orchestrator's host, extracted from content.js (item 30a)
 *
 * orchestrator.js depends on a `host` object with 12 callbacks
 * (onIntervention, onParagraphRead, onQuizOfferEligible, onStruggle,
 * setCogState, setCurrentParagraph, setPrevParagraphText, getCurrentParagraph,
 * findParagraphAt, focusRuler, sessionTracker, log) plus a separate
 * `comprehensionMonitor` constructor argument. Those used to live inline in
 * content.js — a content script, which Chrome never injects into a
 * chrome-extension:// page, so the PDF/PPTX viewers (item 30c) could not
 * construct one. This module is importable from either context.
 *
 * See the project notes' "Extracting the host from content.js (item 30a)" section
 * for the full inventory of what moved here, what stayed in content.js, and
 * why — this header only summarises the two non-obvious design points:
 *
 * - Settings are read live through the injected `settings()` accessor,
 *   never captured once, for the same reason content.js itself holds every
 *   setting as a loose `let`: a captured copy goes stale the moment the
 *   storage listener fires. This accessor's surface is deliberately small —
 *   only what code in *this* module actually reads (`assistantEnabled`,
 *   `backendUrl`). orchestrator.js has its own, separate `settings()`
 *   accessor with a different surface, built and passed by the caller.
 * - `orchestrator` does not exist yet when this module's `questionCard` (and
 *   the `runQuiz`/`onAnswered`/`onDismissed` closures around it) are built —
 *   `orchestrator` needs `host` first. `setOrchestrator()` resolves this the
 *   same way content.js always has: a reference that starts `null` and is
 *   set once, right after `createOrchestrator()` resolves. A reader cannot
 *   answer a question before boot completes, so the closures below never
 *   observe the `null` state in practice.
 */

const AI_CALL_BURST_LIMIT       = 6;        // calls
const AI_CALL_BURST_WINDOW_MS   = 10_000;   // per 10s
const AI_CALL_CEILING_LIMIT     = 30;       // calls
const AI_CALL_CEILING_WINDOW_MS = 600_000;  // per 10 minutes

const QUIZ_TARGET_COUNT  = 8;
const QUIZ_MIN_QUESTIONS = 5;

export async function createHost(deps) {
  const {
    loadModule,
    ui,      // already-constructed ui-controller.js instance — shared, not built here
    esc,     // from ui-controller.js's own exports
    log,     // content.js's _log
    warn,    // content.js's _warn
    settings, // () => { assistantEnabled, backendUrl }
  } = deps;

  const s = () => settings() || {};
  const BACKEND_DEFAULT = self.ALCOIA_CONFIG.SUMMARIZE_URL;

  const {
    reservePopup, showPopup, closePopup, highlightElement,
    showNudge, showSimulateToast, showStatusToast,
  } = ui;

  // ── AI-call infrastructure ────────────────────────────────────────────
  const installTokenModule = await loadModule('src/shared/install-token.js');
  const installToken = installTokenModule.createInstallTokenManager({
    tokenUrl: self.ALCOIA_CONFIG.TOKEN_URL,
  });
  const diagLogModule = await loadModule('src/shared/diag-log.js');
  const diagLog = diagLogModule.createDiagLog();
  const tokenUrl = () => {
    try { return new URL('/api/token', s().backendUrl || BACKEND_DEFAULT).href; }
    catch (e) { return self.ALCOIA_CONFIG.TOKEN_URL; }
  };
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

  // Item 38: bug backstop, not entitlement enforcement — see the project notes'
  // "Client-side AI-call rate limiting" section for the full reasoning.
  const _summaryCache = new Map();
  const aiCallTimestampsByPath = { summarize: [], questions: [] };
  function checkAiCallBudget(path, mode) {
    const now = Date.now();
    const list = (aiCallTimestampsByPath[path] || (aiCallTimestampsByPath[path] = []))
      .filter((t) => now - t < AI_CALL_CEILING_WINDOW_MS);
    aiCallTimestampsByPath[path] = list;
    const burstCount = list.filter((t) => now - t < AI_CALL_BURST_WINDOW_MS).length;
    if (burstCount >= AI_CALL_BURST_LIMIT) {
      diagLog.log(path, `rate_limited_burst mode=${mode} count=${burstCount}`);
      return false;
    }
    if (list.length >= AI_CALL_CEILING_LIMIT) {
      diagLog.log(path, `rate_limited_ceiling mode=${mode} count=${list.length}`);
      return false;
    }
    list.push(now);
    return true;
  }

  async function fetchSummary(text, mode = 'tldr', context = '') {
    if (mode !== 'page_summary') {
      const cacheKey = `${mode}:${text.slice(0, 80).trim()}`;
      if (_summaryCache.has(cacheKey)) {
        log(`Cache hit: ${mode}`);
        return _summaryCache.get(cacheKey);
      }
    }
    if (!checkAiCallBudget('summarize', mode)) return null;
    try {
      const url = s().backendUrl || BACKEND_DEFAULT;
      log(`Fetching ${url} mode=${mode} len=${text.length}`);
      const body = { text: text.slice(0, 3500), mode };
      if (context) body.context = context.slice(0, 800);
      const resp = await callBackend('summarize', url, body);
      if (!resp.ok) { warn(`Server ${resp.status || ''} ${resp.error || ''}`); return null; }
      const j = resp.data;
      if (!j) return null;
      const result = j.summary || j.result || null;
      if (result && mode !== 'page_summary') {
        const cacheKey = `${mode}:${text.slice(0, 80).trim()}`;
        _summaryCache.set(cacheKey, result);
        if (_summaryCache.size > 100) _summaryCache.delete(_summaryCache.keys().next().value);
      }
      return result;
    } catch (e) {
      warn('fetchSummary failed:', e.message);
      return null;
    }
  }

  const questionsUrl = () => (s().backendUrl || BACKEND_DEFAULT).replace(/\/api\/summarize\/?$/, '/api/questions');

  async function fetchQuestions(text, opts = {}) {
    if (!text || text.trim().length < 120) return [];
    if (!checkAiCallBudget('questions', opts.kind || 'recall')) return [];
    const body = {
      text: text.slice(0, 3500),
      language: (document.documentElement.lang || '').slice(0, 5),
      count: opts.count || 1,
      kind: opts.kind || 'recall',
    };
    const resp = await callBackend('apiPost', questionsUrl(), body);
    if (!resp.ok) {
      log(`Questions unavailable (${resp.status || resp.error || 'error'})`);
      return [];
    }
    const j = resp.data;
    if (!j) return [];
    return Array.isArray(j.questions) ? j.questions : [];
  }

  // ── comprehensionMonitor, sessionTracker, focusRuler ──────────────────
  const compModule = await loadModule('src/content/comprehension-monitor.js');
  const comprehensionMonitor = compModule.createComprehensionMonitor({
    speedRatio:      0.30,
    minWords:        70,
    minDifficulty:   58,
    backtrackWindow: 4000,
    cooldown:        30000,
  });

  const sessionModule = await loadModule('src/content/session-tracker.js');
  const sessionTracker = sessionModule.createSessionTracker();

  const rulerModule = await loadModule('src/content/focus-ruler.js');
  const focusRuler = rulerModule.createFocusRuler();

  // ── Snooze (item 18) ───────────────────────────────────────────────────
  const snoozeModule = await loadModule('src/content/snooze.js');
  const snoozeControl = snoozeModule.createSnoozeControl();

  /* Shared by the card's own snooze control and the popup's snoozeReminders
   * message handler (still in content.js). */
  async function startSnooze(durationMs, label) {
    const until = await snoozeControl.snooze(durationMs);
    showStatusToast(`Snoozed${label ? ' for ' + label : ''} — reminders paused`);
    return until;
  }

  // ── orchestrator reference — see this file's own header ───────────────
  let orchestratorRef = null;
  function setOrchestrator(o) { orchestratorRef = o; }

  // ── Question layer ─────────────────────────────────────────────────────
  const responseModule = await loadModule('src/content/signals/response-signals.js');
  const cardModule     = await loadModule('src/content/question-card.js');
  const responseSignals = responseModule.createResponseSignals();
  const recallModule = await loadModule('src/content/signals/session-recall.js');
  const sessionRecall = recallModule.createSessionRecall();

  const questionCard = cardModule.createQuestionCard({
    ui,
    esc,
    responseSignals,
    fetchExplanation: (spanText) => fetchSummary(spanText, 'explain_more'),
    onAnswered: (record) => {
      try { orchestratorRef?.pumpSignals(record); } catch (e) {}
      try { sessionTracker.recordSignal('response', record.subtype, record.span || ''); } catch (e) {}
      if (record.paragraphKey) sessionRecall.recordAnswered(record.paragraphKey, record.correct);
      try { orchestratorRef?.interventionPolicy.recordAnswered(); } catch (e) {}
    },
    onDismissed: () => {
      try { orchestratorRef?.interventionPolicy.recordDismissal(); } catch (e) {}
    },
    onSnooze: (durationMs, label) => { startSnooze(durationMs, label); },
  });

  // ── Quiz generation ─────────────────────────────────────────────────────
  function openQuizPage(key) {
    const url = chrome.runtime.getURL('src/popup/quiz.html') + (key ? '?key=' + encodeURIComponent(key) : '');
    try { chrome.runtime.sendMessage({ action: 'openTab', url }); } catch (e) {}
  }

  let quizGenerating = false;
  async function runQuiz() {
    if (quizGenerating) return false;
    const key = orchestratorRef?.documentKey();
    if (!key) return false;

    quizGenerating = true;
    try {
      const picked = sessionRecall.select(QUIZ_TARGET_COUNT);
      if (!picked.length) return false;

      const combinedText = picked.map((p) => p.text).join('\n\n');
      const questions = await fetchQuestions(combinedText, { count: QUIZ_TARGET_COUNT, kind: 'recall' });
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

  /* This IS onQuizOfferEligible's implementation. Reader-initiated once
   * shown — quiz-offer.js never touches intervention-policy.js, and neither
   * does dismissing this card. */
  function showQuizOffer(result) {
    if (!s().assistantEnabled) return;
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

  // ── Session recall — reader-initiated review ───────────────────────────
  let recallRunning = false;
  function waitForCardToClose() {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const open = document.querySelector('.sra-popup .sra-q-options');
        if (!open || Date.now() - started > 120000) { clearInterval(tick); resolve(); }
      }, 400);
    });
  }
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

  /* Returns true only if a card reached the screen. */
  async function handleAsk(decision, state, target) {
    const el = target || (currentParagraph?.type === 'dom' ? currentParagraph.data : null);
    const text = el ? (el.innerText || el.textContent || '').trim() : (state.signal?.text || '');
    if (!text) return false;

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

  // ── Paragraph state — what setCurrentParagraph/setPrevParagraphText/
  // setCogState/getCurrentParagraph hold ──────────────────────────────────
  let currentParagraph = null;
  let prevParagraphText = '';
  let lastCogState = 'unknown';

  // ── Paragraph finder ────────────────────────────────────────────────────
  // pdfHandler/pptxHandler are deliberately not imported or known about
  // here — see this file's own header and the project notes' item-30a section.
  // content.js (today) and the PDF/PPTX viewer (item 30c) both inject
  // whatever handler they detected, or nothing at all.
  let pdfHandler = null;
  let pptxHandler = null;
  function setPdfHandler(h) { pdfHandler = h; }
  function setPptxHandler(h) { pptxHandler = h; }

  const overlayUtils = await loadModule('src/content/overlay-utils.js');

  async function findParagraphAt(cx, cy) {
    if (pdfHandler?.findParagraphAt)  { const p = await pdfHandler.findParagraphAt(cx, cy);  if (p) return { type: 'pdf', data: p }; }
    if (pptxHandler?.findParagraphAt) { const p = await pptxHandler.findParagraphAt(cx, cy); if (p) return { type: 'pptx', data: p }; }
    const el = document.elementFromPoint(cx, cy);
    if (!el) return null;
    return { type: 'dom', data: overlayUtils.getBlockAncestor(el) || el };
  }

  // ── The 12-callback surface orchestrator.js requires ───────────────────
  const host = {
    sessionTracker,
    focusRuler,
    log,
    findParagraphAt,
    getCurrentParagraph: () => currentParagraph,
    setCurrentParagraph: (p) => { currentParagraph = p; },
    setPrevParagraphText: (t) => { prevParagraphText = t; },
    setCogState: (label) => { lastCogState = label; },
    onParagraphRead: (text, dwellMs) => sessionRecall.recordRead(text, dwellMs),
    onStruggle: (text) => sessionRecall.recordStruggle(text),
    onQuizOfferEligible: (result) => showQuizOffer(result),
    onIntervention: async (decision, state, target) => {
      if (!s().assistantEnabled) return false;
      // Item 18: only the final render is suppressed — see snooze.js's own
      // header for why detection/coverage/the quiz gate keep running above.
      if (await snoozeControl.isActive()) return false;
      if (decision.action === 'nudge') {
        showNudge(target);
        if (target) highlightElement(target, 3000);
        return true;
      }
      if (decision.action === 'ask') {
        return await handleAsk(decision, state, target);
      }
      return false;
    },
  };

  return {
    host,
    setOrchestrator,
    comprehensionMonitor,
    // Same instances as host.sessionTracker/host.focusRuler — exposed at
    // the top level too since content.js's own content-script-only manual
    // paths (the receipt, Alt+F, the simulate/manual AI-trigger path) need
    // them directly, not just through orchestrator.js's view of `host`.
    sessionTracker,
    focusRuler,
    fetchSummary,
    fetchQuestions,
    // Exposed for content.js's receipt signing (receipt.js's signReceipt),
    // a reader-initiated cryptographic operation, not an AI call — it needs
    // the same token-attaching relay fetchSummary/fetchQuestions use, but
    // deliberately bypasses checkAiCallBudget() by calling this directly
    // instead of going through either of them (see item 38's own scope note).
    callBackend,
    questionCard,
    runQuiz,
    runSessionRecall,
    startSnooze,
    snoozeControl,
    // Popup-triggered snooze (msg.action === 'snoozeReminders') sends only an
    // option id — the duration math stays canonical in snooze.js, resolved
    // from this same list rather than a second copy in content.js.
    SNOOZE_OPTIONS: snoozeModule.SNOOZE_OPTIONS,
    sessionRecall,
    // The receipt (content.js's own manual, Alt+I feature) reads
    // responseSignals.stats()/.history() directly — not part of the
    // 12-callback contract, but responseSignals lives here since it feeds
    // questionCard, which is host-owned.
    responseSignals,
    diagLog,
    installToken,
    setPdfHandler,
    setPptxHandler,
    getCogState: () => lastCogState,
    getPrevParagraphText: () => prevParagraphText,
  };
}
