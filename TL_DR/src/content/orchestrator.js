/* orchestrator.js — the detection pipeline, wired together
 *
 * Owns everything between "a reader did something" and "the policy says this
 * earns an interruption". It creates the telemetry detectors, the state engine
 * and the interruption budget, subscribes the one handler that can reach the
 * reader, and runs the gaze classification loop.
 *
 * It does not render. When an interruption is allowed it calls
 * `host.onIntervention()` and takes a boolean back saying whether anything
 * actually reached the screen — the budget is spent only on a yes. That
 * split is deliberate: an offer that bails out downstream must not burn one
 * of the five interruptions a reader gets per session.
 *
 * `content.js` keeps the shared mutable state (settings flags, the current
 * paragraph), so this reads them through the `settings` and `host` accessors
 * rather than capturing copies that would go stale the moment the storage
 * listener fires.
 */

const CLASSIFY_INTERVAL = 3000;
const IDLE_TICK_MS      = 5000;
const GAZE_QUALITY_GATE = 0.25;   // the extractor's own floor; the engine holds a higher one

export async function createOrchestrator(deps) {
  const {
    loadModule,
    comprehensionMonitor,
    featureExtractor,
    classifyGazeState,
    getSmoothedState,
    gazeUtils,
    dyslexiaUtils,
    langDetect,
    settings,        // () => { comprehensionCheckEnabled, eyeTrackingEnabled, ... }
    host,            // see the destructure below
  } = deps;

  const s = () => settings() || {};

  const engineModule = await loadModule('src/content/state-engine.js');
  const policyModule = await loadModule('src/content/intervention-policy.js');
  const stateEngine  = engineModule.createReadingStateEngine();
  const interventionPolicy = policyModule.createInterventionPolicy();

  // Telemetry detectors. These need no permission and work with the camera
  // off, which is the default. Paragraph tracking in particular used to hang
  // off the gaze point, so none of this fired unless the webcam was running.
  const [paraTrackModule, regressionModule, interactionModule,
         dynamicsModule, cursorModule, entropyModule] = await Promise.all([
    loadModule('src/content/telemetry/paragraph-tracker.js'),
    loadModule('src/content/telemetry/scroll-regression.js'),
    loadModule('src/content/telemetry/interaction-signals.js'),
    loadModule('src/content/telemetry/scroll-dynamics.js'),
    loadModule('src/content/telemetry/cursor-tracking.js'),
    loadModule('src/content/telemetry/progression-entropy.js'),
  ]);

  const paragraphTracker   = paraTrackModule.createParagraphTracker({ minWords: 20 });
  const scrollRegression   = regressionModule.createScrollRegressionDetector();
  const interactionSignals = interactionModule.createInteractionSignals();
  const scrollDynamics     = dynamicsModule.createScrollDynamics();
  const cursorTracker      = cursorModule.createCursorTracker();
  const progressionEntropy = entropyModule.createProgressionEntropy();

  // Latest reading from the gaze pipeline. Written by the classify loop, read
  // whenever a telemetry signal arrives, so the engine considers both at once
  // instead of them racing each other to the reader.
  let lastGazeLabel   = null;
  let lastGazeQuality = 0;

  // Last deliberate input. Used only to spot someone who has stopped making
  // progress — never stored, never sent anywhere.
  let lastInputAt = Date.now();

  let classifyTimer = null;
  let idleTimer     = null;
  let lowQualityStreak = 0;
  let lastQualityWarnAt = 0;
  let interventionInFlight = false;

  // ── Views handed to the engine ───────────────────────────────────────────
  function currentGazeView() {
    if (!s().eyeTrackingEnabled) return { enabled: false };
    let presence = null;
    try { presence = featureExtractor.presence(); } catch (e) {}
    return {
      enabled: true,
      label: lastGazeLabel,
      quality: lastGazeQuality,
      lastSampleAt: host.getLastGazeReceivedAt() || null,
      facePresent: presence ? presence.face_present : null,
      onPageFraction: presence ? presence.on_page_fraction : null,
    };
  }

  function buildIdleView() {
    let expectation = null;
    try { expectation = comprehensionMonitor.getCurrentExpectation(); } catch (e) {}
    if (!expectation) return null;
    return {
      pageFocused:  document.hasFocus(),
      msSinceInput: Date.now() - lastInputAt,
      expectedMs:   expectation.expectedMs,
    };
  }

  /* Drains every detector and hands the batch over in one go, so the engine
   * sees a whole moment rather than a sequence of unrelated nudges. */
  function pumpTelemetry(extra) {
    const batch = [];
    for (const sig of [scrollRegression.signal(), scrollDynamics.signal(), progressionEntropy.signal()]) {
      if (sig) batch.push(sig);
    }
    const interactions = interactionSignals.signal();
    if (interactions) batch.push(...interactions);
    if (extra) batch.push(extra);
    if (!batch.length) return;
    stateEngine.update({ telemetry: batch, gaze: currentGazeView(), idle: buildIdleView() });
  }

  /* Viewport-driven paragraph tracking. Feeds the comprehension monitor's
   * reading-rate maths and the regression detector's paragraph indices. */
  function syncParagraph() {
    if (!s().comprehensionCheckEnabled) return;
    let transition = null;
    try {
      // A reader tracking text with the mouse gives a measured reading
      // position; fall back to the viewport heuristic when they aren't.
      transition = paragraphTracker.update(cursorTracker.getPointerY());
    } catch (e) { return; }
    if (!transition) return;

    let speedSignal = null;
    if (transition.left) {
      try { speedSignal = comprehensionMonitor.leaveParagraph(); } catch (e) {}
      if (transition.left.el) {
        const text = (transition.left.el.innerText || transition.left.el.textContent || '');
        host.setPrevParagraphText(text.trim().slice(0, 800));
      }
    }
    if (transition.entered?.el) {
      try { comprehensionMonitor.enterParagraph(transition.entered.el); } catch (e) {}
      host.setCurrentParagraph({ type: 'dom', data: transition.entered.el });
    }

    try { scrollRegression.update(transition); } catch (e) {}
    try { progressionEntropy.update(transition); } catch (e) {}
    pumpTelemetry(speedSignal);
  }

  // ── The one path to the reader ───────────────────────────────────────────
  stateEngine.subscribe(async (state) => {
    host.setCogState(state.label);
    try { chrome.storage.local.set({ sra_current_state: state.label }); } catch (e) {}
    try { host.sessionTracker.recordState(state.label); } catch (e) {}
    if (s().focusRulerEnabled) {
      try { host.focusRuler.adaptToState(state.label); } catch (e) {}
    }

    const currentParagraph = host.getCurrentParagraph();
    const currentEl = currentParagraph?.type === 'dom' ? currentParagraph.data : null;
    const decision  = interventionPolicy.evaluate(state, { currentEl });

    if (s().debugEnabled) {
      host.log(`State: ${state.label} (conf ${state.confidence.toFixed(2)}, camera ${state.cameraContribution.toFixed(2)}) — ${decision.allow ? 'ACT: ' + decision.action : 'hold: ' + decision.reason}`);
    }
    if (!decision.allow) return;
    // The handler awaits, so guard against a second state arriving mid-render.
    if (interventionInFlight) return;
    interventionInFlight = true;

    try {
      // With the camera off there is no gaze point, so nothing has told us
      // which paragraph the reader is on. Fall back to the middle of the
      // viewport rather than dropping the interruption.
      let target = currentEl;
      if (!target) {
        try {
          const para = await host.findParagraphAt(window.innerWidth / 2, window.innerHeight / 2);
          if (para?.type === 'dom') { host.setCurrentParagraph(para); target = para.data; }
        } catch (e) {}
      }

      const shown = await host.onIntervention(decision, state, target);

      // Budget is spent once, and only for something the reader actually saw.
      if (shown) {
        interventionPolicy.record(decision);
        try {
          host.sessionTracker.recordSignal(state.label, decision.action, decision.evidence[0] || '');
        } catch (e) {}
      } else if (s().debugEnabled) {
        host.log(`Interruption dropped before render (${state.label}) — budget not spent`);
      }
    } finally {
      interventionInFlight = false;
    }
  });

  // ── Gaze classification loop ─────────────────────────────────────────────
  function classifyTick() {
    const cfg = s();
    if (!cfg.eyeTrackingEnabled || !host.getLastGazePoint()) return;
    const rawFeatures = featureExtractor.computeFeatures();
    if (!rawFeatures) return;

    // Skip classification when webcam tracking is too noisy — poor lighting,
    // glasses glare, face partially occluded.
    if (rawFeatures.gaze_quality < GAZE_QUALITY_GATE) {
      if (cfg.debugEnabled) {
        host.log(`Skipping classify — low gaze quality (${(rawFeatures.gaze_quality * 100).toFixed(0)}%)`);
      }
      lowQualityStreak++;
      if (lowQualityStreak >= 8 && Date.now() - lastQualityWarnAt > 60000) {
        host.onQualityWarning();
        lastQualityWarnAt = Date.now();
      }
      return;
    }
    lowQualityStreak = 0;

    // Normalise against the reader's own baseline so individual reading styles
    // don't bias the classifier's fixed thresholds.
    const features = cfg.personalBaseline
      ? gazeUtils.normalizeWithBaseline(rawFeatures, cfg.personalBaseline)
      : rawFeatures;

    const dyslexiaPatched = cfg.dyslexiaEnabled
      ? dyslexiaUtils.patchFeaturesForDyslexia(features)
      : features;

    // Script-aware patch: flip regression_rate for RTL, scale fixation_ms for CJK.
    const classFeatures = langDetect.patchFeaturesForScript(dyslexiaPatched, cfg.scriptInfo);

    const { label } = classifyGazeState(classFeatures);

    // Smooth over 3 windows to prevent single-sample false triggers.
    lastGazeLabel   = getSmoothedState(label);
    lastGazeQuality = rawFeatures.gaze_quality;

    host.onGazeFeatures(rawFeatures);

    // Gaze fires nothing by itself. It hands its reading to the engine, which
    // will not turn it into an actionable state without telemetry behind it.
    stateEngine.update({ gaze: currentGazeView(), idle: buildIdleView() });
  }

  function startClassificationLoop() {
    if (classifyTimer) clearInterval(classifyTimer);
    host.log('Classification loop started');
    classifyTimer = setInterval(classifyTick, CLASSIFY_INTERVAL);
  }

  function stopClassificationLoop() {
    if (classifyTimer) clearInterval(classifyTimer);
    classifyTimer = null;
  }

  /* Tear everything down. Not called in the extension today — the content
   * script lives as long as the page — but the timers are owned here, so the
   * ability to stop them belongs here too rather than being unreachable. */
  function stop() {
    stopClassificationLoop();
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }

  // ── Event wiring ─────────────────────────────────────────────────────────
  const activeParagraphIndex = () => paragraphTracker.getActive()?.index ?? null;

  function installListeners() {
    const markInput = () => { lastInputAt = Date.now(); };
    for (const ev of ['scroll', 'mousemove', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, markInput, { passive: true });
    }

    // Cursor as a reading pointer. Most mouse movement is not reading, so the
    // tracker decides for itself whether the behaviour qualifies.
    window.addEventListener('mousemove', (e) => {
      if (!s().comprehensionCheckEnabled) return;
      try { cursorTracker.update(e.clientX, e.clientY); } catch (err) {}
    }, { passive: true });

    window.addEventListener('scroll', () => {
      if (!s().comprehensionCheckEnabled) return;
      try {
        scrollDynamics.update(window.scrollY);
        syncParagraph();
        const signal = comprehensionMonitor.onScroll();
        if (signal) pumpTelemetry(signal);
      } catch (e) {}
    }, { passive: true });

    // Selection and copy are corroboration, never triggers — the selection
    // summary feature already responds to the reader's own action, and firing
    // an interruption on top of it would interrupt twice for one gesture.
    let selectionDebounce = null;
    document.addEventListener('selectionchange', () => {
      if (!s().comprehensionCheckEnabled) return;
      clearTimeout(selectionDebounce);
      selectionDebounce = setTimeout(() => {
        try {
          const text = String(window.getSelection?.() || '');
          if (text.trim()) interactionSignals.update({ kind: 'selection', text });
        } catch (e) {}
      }, 400);
    });

    document.addEventListener('copy', () => {
      if (!s().comprehensionCheckEnabled) return;
      try {
        const text = String(window.getSelection?.() || '');
        if (text.trim()) interactionSignals.update({ kind: 'copy', text });
      } catch (e) {}
    });

    // Blur/return: coming back to the same paragraph after a long absence is a
    // confirmed loss of the thread. Carrying on forwards is not.
    window.addEventListener('blur', () => {
      try { interactionSignals.update({ kind: 'blur', paragraphIndex: activeParagraphIndex() }); } catch (e) {}
    });
    window.addEventListener('focus', () => {
      if (!s().comprehensionCheckEnabled) return;
      try {
        syncParagraph();
        interactionSignals.update({ kind: 'focus', paragraphIndex: activeParagraphIndex() });
        pumpTelemetry();
      } catch (e) {}
    });

    // Slow tick so a reader who has stopped scrolling is still observed —
    // dwelling on one paragraph produces no events at all.
    idleTimer = setInterval(() => {
      if (!s().comprehensionCheckEnabled) return;
      try { syncParagraph(); pumpTelemetry(); } catch (e) {}
    }, IDLE_TICK_MS);
  }

  /* Enter the first paragraph now, or nothing is timed until the reader
   * scrolls — which loses the opening of every article. */
  function primeParagraph() {
    try { paragraphTracker.rescan(); syncParagraph(); } catch (e) {}
  }

  return {
    installListeners,
    primeParagraph,
    syncParagraph,
    pumpTelemetry,
    startClassificationLoop,
    stopClassificationLoop,
    stop,
    getState: () => stateEngine.getState(),
    getActiveParagraphEl: () => paragraphTracker.getActive()?.el || null,
    // Exposed for the popup's manual paths and for tests.
    stateEngine,
    interventionPolicy,
    paragraphTracker,
  };
}
