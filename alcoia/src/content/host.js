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
 * See CLAUDE.md's "Extracting the host from content.js (item 30a)" section
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
    // Item S6/E4 follow-up. Both undefined/null for EVERY caller except
    // reading-bridge.js opening a document from the Assignments entry
    // point — content.js (every ordinary web page) never passes either,
    // so submitOutcome below stays a no-op there, unchanged from before
    // this item existed. assignmentId is the whole reading session's
    // context, established once at construction — not per-signal.
    assignmentId = null,
    getSession = null,
  } = deps;

  const s = () => settings() || {};
  const BACKEND_DEFAULT = self.ALCOIA_CONFIG.SUMMARIZE_URL;

  // ── Outcome reporting (item S6/E4 follow-up) ────────────────────────────
  // The SAME detection pipeline as ordinary reading, now also reporting
  // outward — no new gate here. Whatever already decided a struggle signal
  // or a question should fire (state-engine.js's transitions, intervention-
  // policy.js's per-paragraph budget, the coverage gate governing the
  // quiz/session-recall paths) is unchanged by this item; submitOutcome()
  // is purely a tap on signals that already passed through them, not a
  // second gate of its own. Fire-and-forget, one POST per discrete signal,
  // no batching — see outcomes.js's own header for the full reasoning on
  // that choice, made explicitly rather than guessed through.
  let submitOutcome = () => {};
  if (assignmentId && getSession) {
    const outcomesModule = await loadModule('src/shared/outcomes.js');
    const outcomesManager = outcomesModule.createOutcomesManager({
      getSession,
      outcomesUrl: `${self.ALCOIA_CONFIG.ASSIGNMENTS_URL}/${encodeURIComponent(assignmentId)}/outcomes`,
    });
    submitOutcome = (fields) => {
      // A session-recall review question (host.js's runSessionRecall, not
      // handleAsk) has no reliable numeric index — session-recall.js
      // keys everything by truncated text, never an ordinal — so this
      // guard is what keeps those answers from attempting (and always
      // failing) a submission, rather than special-casing that call site.
      if (!Number.isInteger(fields.paragraphIndex) || fields.paragraphIndex < 0) return;
      outcomesManager.submit(fields).catch(() => {});
    };
  }

  // ── Scroll-kinematics reporting (item DC-1a) ────────────────────────────
  // Identical gate to submitOutcome above, for the identical reason: the
  // real server endpoint (confirmed by reading alcoiaServer's
  // src/http/routes/scroll-sessions.js directly, not assumed) requires a
  // real assignmentId and an active seat in that assignment's class — there
  // is no server-side path for a general "any signed-in reader" corpus, so
  // this stays a no-op for every ordinary content.js page exactly the way
  // submitOutcome already does, unchanged from before this item. Called once
  // per session, at unload (content.js's/viewer.js's own beforeunload
  // handler), never mid-session — see kinematics.js's own header for why
  // that specific moment needs keepalive:true, unlike submitOutcome's calls.
  let submitKinematics = () => {};
  if (assignmentId && getSession) {
    const kinematicsModule = await loadModule('src/shared/kinematics.js');
    const kinematicsManager = kinematicsModule.createKinematicsManager({
      getSession,
      kinematicsUrl: self.ALCOIA_CONFIG.KINEMATICS_URL,
    });
    submitKinematics = (kinematics) => {
      kinematicsManager.submit({ assignmentId, kinematics }).catch(() => {});
    };
  }

  const {
    reservePopup, showPopup, closePopup, highlightElement,
    showNudge, showSimulateToast, showStatusToast,
  } = ui;

  // ── AI-call infrastructure ────────────────────────────────────────────
  const diagLogModule = await loadModule('src/shared/diag-log.js');
  const diagLog = diagLogModule.createDiagLog();
  const tokenUrl = () => {
    try { return new URL('/api/token', s().backendUrl || BACKEND_DEFAULT).href; }
    catch (e) { return self.ALCOIA_CONFIG.TOKEN_URL; }
  };
  // Item 43: callBackend()/installToken extracted to src/shared/backend-client.js
  // so quiz.js (a normal extension page, not this content-script host) can
  // reach the grading endpoint the same way, without duplicating the
  // token/retry logic — see that file's own header.
  const backendClientModule = await loadModule('src/shared/backend-client.js');
  const { callBackend, installToken } = backendClientModule.createBackendClient({ getTokenUrl: tokenUrl, diagLog });

  // Item 38: bug backstop, not entitlement enforcement — see CLAUDE.md's
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
    // Item 42/44: one level per call, decided by the caller — omitted
    // entirely rather than defaulted here, so a server that has never heard
    // of levels sees exactly the request shape it always has.
    if (opts.level) body.level = opts.level;
    const resp = await callBackend('apiPost', questionsUrl(), body);
    if (!resp.ok) {
      log(`Questions unavailable (${resp.status || resp.error || 'error'})`);
      return [];
    }
    const j = resp.data;
    if (!j) return [];
    return Array.isArray(j.questions) ? j.questions : [];
  }

  // ── Free-text answer grading (item 43) ──────────────────────────────────
  // Grading authority degrades by level — see tests/contract/grading.js's
  // header for the full reasoning. recognition is deterministic and never
  // reaches this function at all; adversarial is never graded, refused
  // before any network call. Own rate-limit bucket ('grade'), separate from
  // 'summarize' and 'questions' — a burst of grading calls must not starve
  // or be starved by either of those. The grading logic itself lives in
  // src/shared/grading-client.js, shared with quiz.js — see that file's own
  // header for why it was pulled out rather than duplicated.
  const gradingClientModule = await loadModule('src/shared/grading-client.js');
  const { fetchGrading } = gradingClientModule.createGradingClient({
    callBackend,
    getGradeUrl: () => (s().backendUrl || BACKEND_DEFAULT).replace(/\/api\/summarize\/?$/, '/api/grade'),
    checkBudget: checkAiCallBudget,
    log, warn,
  });

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

  // ── Self-report (item 13a) ──────────────────────────────────────────────
  // The "alcoia Evidence Base" research artifact's confusion/overload/
  // boredom section: confusion and overload demand OPPOSITE responses
  // (preserve and work through vs. reduce load) but "behavioral separation
  // is hard... the most reliable disambiguator available to a browser tool
  // is a lightweight probe... a one-tap self-report" — the loop it calls
  // "not optional". This is that probe.
  //
  // Always reader-initiated, from all three affordances (content.js's
  // Alt+C, the persistent trigger below, and active surfacing inside the
  // question card itself) — never called from anywhere the interruption
  // budget governs, so it spends none, the same "reader-initiated actions
  // spend no budget" principle intervention-policy.js's header already
  // states for the quiz/manual paths, extended here to a genuinely new
  // trigger rather than reusing one of those existing ones.
  const stateEngineModule = await loadModule('src/content/state-engine.js');
  const { SELF_REPORT } = stateEngineModule;

  function reportSelfState(subtype) {
    // Fed through the SAME pumpSignals() chokepoint every other reading
    // signal already uses (host.js's own onAnswered callback above does
    // the same for response-signals.js's records) — not a second pathway
    // into the engine. state-engine.js's own SELF_REPORT_CONFIDENCE (1.0,
    // above even a wrong-answer response) is what makes this win
    // strongestAssertion() against anything else batched in the same call,
    // so the resulting state/substate change is reflected on the very next
    // emission — immediate in exactly the sense this codebase's engine
    // already gives every other signal, not a new "sticky override"
    // mechanism layered on top of it.
    try { orchestratorRef?.pumpSignals({ type: 'self_report', subtype }); } catch (e) {}
  }

  const SELF_REPORT_FINGERPRINT = 'sra-self-report';
  /* Affordances 1 (Alt+C, content.js) and 2 (the persistent trigger,
   * ui-controller.js) both open this same standalone card — it exists
   * independent of any active intervention, since a reader can decide to
   * self-report at any moment, not only while a question is on screen.
   * Affordance 3 (active surfacing) is different: it augments the
   * QUESTION card itself, wired below via questionCard's own onSelfReport
   * option, rather than replacing it with this card — see handleAsk's own
   * comment for why replacing the primary intervention outright would be a
   * much bigger behavioural change than this item's own scope. */
  function showSelfReportCard() {
    const root = reservePopup(SELF_REPORT_FINGERPRINT);
    if (!root) return false;

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn sra-close-btn" title="Dismiss">✕</button>
      </div>
      <div class="sra-popup-body">
        <div class="sra-state-badge sra-self-report-badge">How's this going?</div>
        <div class="sra-self-report-options">
          <button type="button" class="sra-btn sra-btn-secondary" data-self-report="${SELF_REPORT.OVERLOAD}">Too much at once</button>
          <button type="button" class="sra-btn sra-btn-secondary" data-self-report="${SELF_REPORT.CONFUSION}">I'm stuck / don't get it</button>
          <button type="button" class="sra-btn sra-btn-secondary" data-self-report="${SELF_REPORT.DISENGAGED}">Not interested / lost focus</button>
        </div>
      </div>`;

    root.querySelector('.sra-close-btn').onclick = () => closePopup(root, SELF_REPORT_FINGERPRINT);
    for (const btn of root.querySelectorAll('[data-self-report]')) {
      btn.onclick = () => {
        reportSelfState(btn.dataset.selfReport);
        for (const b of root.querySelectorAll('[data-self-report]')) b.disabled = true;
        btn.textContent = 'Thanks, noted.';
        // Bug found verifying this in real Chromium (tests/browser/smoke.mjs):
        // stored on root._hideT, the SAME property closePopup() already
        // clearTimeout()s on every close path — Escape, the ✕ button, or
        // this auto-close itself. Without that, an early close (Escape,
        // right after this click) left this bare setTimeout alive; every
        // instance of this card shares SELF_REPORT_FINGERPRINT, so when it
        // later fired it closed whatever card currently held that
        // fingerprint — including a genuinely different, still-open one a
        // reader had opened since — deleting its openPopups entry without
        // actually removing it from the DOM, orphaning it: visible,
        // unpinned, and no longer reachable by hidePopup()/Escape at all.
        root._hideT = setTimeout(() => closePopup(root, SELF_REPORT_FINGERPRINT), 900);
      };
    }

    showPopup(root);
    return true;
  }

  // Affordance 2: a persistent trigger, always reachable regardless of
  // whether any intervention is currently on screen — in contrast to
  // affordance 3, which only ever appears alongside an actual question.
  // ui-controller.js owns all rendered chrome (CLAUDE.md: "orchestrator.js
  // decides, ui-controller.js renders"); this just asks it to ensure the
  // trigger exists and wires what a click does. Optional-chained since a
  // ui built with a stub (e.g. some existing tests' fakeUI()) may not
  // implement it — the mechanism this task builds must not throw in a
  // context that predates it.
  try { ui.ensureSelfReportTrigger?.(showSelfReportCard); } catch (e) {}

  // ── Question layer ─────────────────────────────────────────────────────
  const responseModule = await loadModule('src/content/signals/response-signals.js');
  const cardModule     = await loadModule('src/content/question-card.js');
  const responseSignals = responseModule.createResponseSignals();
  const recallModule = await loadModule('src/content/signals/session-recall.js');
  const sessionRecall = recallModule.createSessionRecall();

  // ── Epistemic engine (item 44) ─────────────────────────────────────────
  // Selects the next question TYPE from demonstrated failure rather than
  // rotating formats — see that module's own header for the ladder and its
  // rules. Pure: it only ever reads responseSignals.history(), the same
  // session-scoped, in-memory record every other consumer of that history
  // (the receipt, sessionRecall.recordAnswered) already reads — nothing new
  // is stored or transmitted to make this work. Used identically by every
  // place a question gets generated below (handleAsk, runSessionRecall,
  // runQuiz) — "same engine, same rules" is structural, not a convention to
  // remember, since all three call this one function.
  const engineModule = await loadModule('src/content/epistemic-engine.js');
  function pickLevel(paragraphKey) {
    return engineModule.pickLevelForConcept(paragraphKey, responseSignals.history());
  }

  const questionCard = cardModule.createQuestionCard({
    ui,
    esc,
    responseSignals,
    // Item 13a, affordance 3 (active surfacing) — see handleAsk's own
    // comment for when context.showSelfReport is set. Reuses the exact
    // same reportSelfState() affordances 1/2 already call — one signal
    // pathway, three ways to reach it.
    onSelfReport: reportSelfState,
    fetchExplanation: (spanText) => fetchSummary(spanText, 'explain_more'),
    fetchGrading, // item 43 — free_recall/scenario only; question-card.js itself never calls this for recognition or adversarial
    onAnswered: (record) => {
      try { orchestratorRef?.pumpSignals(record); } catch (e) {}
      try { sessionTracker.recordSignal('response', record.subtype, record.span || ''); } catch (e) {}
      if (record.paragraphKey) sessionRecall.recordAnswered(record.paragraphKey, record.correct);
      try { orchestratorRef?.interventionPolicy.recordAnswered(); } catch (e) {}
      // Item S6/E4 follow-up. Deliberately excludes quiz.js's separate
      // standalone-quiz answers — those never reach this callback at all
      // (quiz.js writes straight to quiz-store.js's IndexedDB, which its
      // own header documents as "never transmitted", a design boundary
      // this item does not cross) and dismiss()'s record has no
      // questionId/correct worth reporting either. `correct` is only ever
      // included when it's a real boolean — response-signals.js's own
      // `null` means "not graded" (model verdict 'unknown', or
      // adversarial's deliberate non-grading), not "wrong", and the
      // server rejects `correct` without a `questionId` regardless — both
      // are naturally satisfied here since they come from the same record.
      submitOutcome({
        paragraphIndex: record.paragraphIndex,
        questionId: record.questionId,
        correct: typeof record.correct === 'boolean' ? record.correct : undefined,
        confidence: record.confidence,
        // Item 13j-1: response-signals.js's answer() (recognition, real
        // discrete options) is the only record shape that ever carries
        // chosenIndex — answerGraded()/respond() (free_recall/scenario/
        // adversarial) never set it, so this correctly sends an explicit
        // null for those rather than fabricating an option id.
        selectedAnswer: typeof record.chosenIndex === 'number' ? record.chosenIndex : null,
      });
    },
    onDismissed: () => {
      try { orchestratorRef?.interventionPolicy.recordDismissal(); } catch (e) {}
    },
    onSnooze: (durationMs, label) => { startSnooze(durationMs, label); },
  });

  // ── Quiz generation ─────────────────────────────────────────────────────
  // Item 13i: assignmentId, if this page has one, rides along on the quiz
  // URL exactly the way assignments.js already appends it to the PDF
  // viewer URL — quiz.js is a separate extension page (no content-script
  // context to inherit it from) and reads it back the same way viewer.js
  // does, to know it should report outcomes for this specific quiz.
  function openQuizPage(key) {
    let url = chrome.runtime.getURL('src/popup/quiz.html') + (key ? '?key=' + encodeURIComponent(key) : '');
    if (assignmentId) url += (key ? '&' : '?') + 'assignmentId=' + encodeURIComponent(assignmentId);
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

      const questions = [];
      if (assignmentId) {
        // Item 13i: a quiz outcome needs a real paragraph_index per
        // question (13g's server contract), and a question generated from
        // several paragraphs' COMBINED text (the ordinary path below)
        // cannot be attributed back to just one of them. So under
        // assignment context specifically, generation is one
        // fetchQuestions() call per picked paragraph instead — more AI
        // calls than the ordinary path, deliberately, only here — and each
        // resulting question is tagged with the real paragraphIndex
        // sessionRecall recorded it under (session-recall.js's own
        // comment on recordRead()). A paragraph with no recorded index
        // (shouldn't happen in practice, but not assumed) yields questions
        // with paragraphIndex: null — outcomes.js's own guard already
        // refuses to submit those rather than guessing one.
        for (const p of picked) {
          const paragraphKey = p.text.slice(0, 80).trim();
          const level = pickLevel(paragraphKey);
          const opts = { count: Math.max(1, Math.round(QUIZ_TARGET_COUNT / picked.length)), kind: 'recall' };
          if (level !== 'recognition') opts.level = level;
          const qs = await fetchQuestions(p.text, opts);
          for (const q of qs) q.paragraphIndex = Number.isInteger(p.paragraphIndex) ? p.paragraphIndex : null;
          questions.push(...qs);
        }
      } else {
        // Item 44: quiz questions get generated at whatever level each picked
        // paragraph's session history calls for, not always recognition — but
        // this stays ONE fetchQuestions call per distinct level needed
        // (bounded at 4, the ladder's own size), not one per paragraph.
        // tests/contract/questions.js only accepts one level per call, so
        // paragraphs that land on the same level are combined into the same
        // request, same as the un-escalated version of this function always
        // combined all of them into one. In practice most paragraphs have no
        // prior attempt this session and land on 'recognition' together, so
        // this is usually still the same single call it always was.
        const groups = new Map(); // level -> paragraph texts
        for (const p of picked) {
          const paragraphKey = p.text.slice(0, 80).trim();
          const level = pickLevel(paragraphKey);
          if (!groups.has(level)) groups.set(level, []);
          groups.get(level).push(p.text);
        }

        // `count` requests how many QUESTIONS to write from the combined text,
        // not how many paragraphs are in it — a single paragraph can and does
        // yield several questions (this is exactly what the un-escalated
        // version of this function always asked for: QUIZ_TARGET_COUNT
        // questions from however many paragraphs got picked). Splitting into
        // level groups must not silently shrink that request to "one question
        // per paragraph" — each group's share of QUIZ_TARGET_COUNT is
        // proportional to how many of the picked paragraphs landed in it, so
        // the single-group case (the common one — most paragraphs have no
        // prior attempt yet) asks for exactly QUIZ_TARGET_COUNT, same as before.
        for (const [level, texts] of groups) {
          const share = Math.max(1, Math.round((QUIZ_TARGET_COUNT * texts.length) / picked.length));
          const opts = { count: share, kind: 'recall' };
          if (level !== 'recognition') opts.level = level;
          const qs = await fetchQuestions(texts.join('\n\n'), opts);
          questions.push(...qs);
        }
      }
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
        // Item 44: a review question can now render either markup branch
        // (.sra-q-options for recognition, .sra-q-freetext for the other
        // three levels) — .sra-q-badge is on the card regardless of level,
        // so this keeps detecting "still open" correctly whichever the
        // engine picked, instead of only ever recognising recognition's own
        // markup and resolving instantly for anything else.
        const open = document.querySelector('.sra-popup .sra-q-badge');
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
        const paragraphKey = entry.text.slice(0, 80).trim();
        // Item 44: what level to ask THIS concept at is decided from the
        // reader's own session history for it, not always recognition —
        // the same pickLevel() every question-generating path below uses.
        const level = pickLevel(paragraphKey);
        const opts = { count: 1 };
        if (level !== 'recognition') opts.level = level;
        const qs = await fetchQuestions(entry.text, opts);
        if (qs.length) questions.push({ question: qs[0], paragraphKey, level });
        if (questions.length >= count) break;
      }

      if (!questions.length) {
        showSimulateToast('Could not prepare a review right now');
        return;
      }

      for (const item of questions) {
        // Item 44: adversarial gets its own calm, non-hostile framing
        // instead of the generic review line — see epistemic-engine.js's
        // own header for why that rung specifically needs it spelled out.
        const evidence = engineModule.evidenceLineForLevel(item.level) || 'Reviewing what you read this session';
        const shown = questionCard.show(item.question, {
          evidence: [evidence],
          paragraphKey: item.paragraphKey,
        });
        if (!shown) continue;
        await waitForCardToClose();
      }
    } finally {
      recallRunning = false;
    }
  }

  /* Returns true only if a card reached the screen. paragraphIndex (item
   * S6/E4 follow-up) is the active paragraph's real ordinal, captured by
   * orchestrator.js at the moment it decided to intervene — see that
   * file's own comment. Threaded through to questionCard.show()'s context
   * purely so an eventual onAnswered record can carry it; nothing in this
   * function's own question-generation logic reads it.
   *
   * Item 13a, affordance 3 (active surfacing): when state.substate is
   * 'unclear' — today, always, since no dedicated confusion/overload
   * signal exists yet (items 13b/13c/13d build those) — the question card
   * ALSO shows the three self-report options alongside the real question,
   * rather than replacing it. Deliberately additive, not a swap: the
   * question is still this system's primary intervention (CLAUDE.md
   * decision #1), and the self-report options are what "visibly ask rather
   * than infer" actually means here — an honest admission next to the
   * question, not instead of it. Costs no extra budget: it rides the SAME
   * 'ask' interruption intervention-policy.js already gated before this
   * function was ever called. */
  async function handleAsk(decision, state, target, paragraphIndex) {
    const el = target || (currentParagraph?.type === 'dom' ? currentParagraph.data : null);
    const text = el ? (el.innerText || el.textContent || '').trim() : (state.signal?.text || '');
    if (!text) return false;

    const paragraphKey = text.slice(0, 80).trim();
    // Item 44: same engine, same rule, as every other caller — in practice
    // this is almost always 'recognition' here, since the interruption
    // budget already refuses to ask about the same paragraph twice
    // automatically; a higher rung only comes up if this exact paragraph
    // was already tested via a review or the quiz earlier this session.
    const level = pickLevel(paragraphKey);
    const opts = level !== 'recognition' ? { level } : {};

    const questions = await fetchQuestions(text, opts);
    if (!questions.length) return false;

    let anchorRect = null;
    try { if (el) anchorRect = el.getBoundingClientRect(); } catch (e) {}
    if (el) highlightElement(el, 4000);

    const evidenceOverride = engineModule.evidenceLineForLevel(level);

    return questionCard.show(questions[0], {
      evidence: evidenceOverride ? [evidenceOverride] : decision.evidence,
      anchorRect,
      paragraphKey,
      paragraphIndex: Number.isInteger(paragraphIndex) ? paragraphIndex : null,
      wasExplorationSample: decision.wasExplorationSample === true,
      showSelfReport: state.substate === 'unclear',
    });
  }

  // ── Paragraph state — what setCurrentParagraph/setPrevParagraphText/
  // setCogState/getCurrentParagraph hold ──────────────────────────────────
  let currentParagraph = null;
  let prevParagraphText = '';
  let lastCogState = 'unknown';

  // ── Paragraph finder ────────────────────────────────────────────────────
  // pdfHandler/pptxHandler are deliberately not imported or known about
  // here — see this file's own header and CLAUDE.md's item-30a section.
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
    onParagraphRead: (text, dwellMs, paragraphIndex) => sessionRecall.recordRead(text, dwellMs, paragraphIndex),
    onStruggle: (text, paragraphIndex, substate, selfReported) => {
      sessionRecall.recordStruggle(text);
      // Item S6/E4 follow-up — see submitOutcome's own header just above.
      // substate/selfReported: already resolved by orchestrator.js at the
      // moment struggle was decided (13a's 'unclear' default translated to
      // null there, not here — see its own comment). source: 'inline'
      // names this specific chokepoint — the in-page retrieval prompt —
      // distinct from quiz.js's separate, never-transmitted path (13i,
      // untouched by this item).
      submitOutcome({ paragraphIndex, struggled: true, substate, selfReported, source: 'inline' });
    },
    onQuizOfferEligible: (result) => showQuizOffer(result),
    onIntervention: async (decision, state, target, paragraphIndex) => {
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
        return await handleAsk(decision, state, target, paragraphIndex);
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
    // Item DC-1a — content.js's/viewer.js's own beforeunload handler calls
    // this directly, the same top-level-exposure reason as sessionTracker
    // just above. Always safe to call unconditionally: a no-op unless this
    // host was constructed with assignmentId+getSession (see above).
    submitKinematics,
    fetchSummary,
    fetchQuestions,
    fetchGrading,
    // Exposed for content.js's receipt signing (receipt.js's signReceipt),
    // a reader-initiated cryptographic operation, not an AI call — it needs
    // the same token-attaching relay fetchSummary/fetchQuestions use, but
    // deliberately bypasses checkAiCallBudget() by calling this directly
    // instead of going through either of them (see item 38's own scope note).
    callBackend,
    questionCard,
    runQuiz,
    runSessionRecall,
    // Item 13a — affordances 1 (content.js's Alt+C) and 2 (a settings/
    // popup-triggered equivalent) both call showSelfReportCard() directly;
    // reportSelfState() is exposed separately in case a caller ever needs
    // to submit one without the standalone card (none does today).
    showSelfReportCard,
    reportSelfState,
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
