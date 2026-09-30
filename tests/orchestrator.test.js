// @vitest-environment jsdom
/* orchestrator.js's first dedicated unit tests. Item 30c added two small,
 * additive constructor options:
 *   - paragraphTrackerOpts — passed straight through to
 *     createParagraphTracker(), letting a non-DOM caller inject a block
 *     source (item 30b's paragraph-tracker.js feature) instead of the
 *     default document.querySelectorAll scan.
 *   - documentKey — an override for coverage-gate.js's default
 *     hostname+pathname key, needed because alcoia's own PDF viewer is one
 *     chrome-extension:// page whose window.location is identical for
 *     every distinct PDF it ever opens; the real per-document identity has
 *     to come from somewhere else (the PDF's own source URL).
 *
 * Scope is deliberately narrow: these two new options, and that omitting
 * them leaves existing behaviour unchanged. Full coverage of the rest of
 * the detection pipeline is what tests/browser/smoke.mjs already exercises
 * end to end on every real page load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOrchestrator } from '../alcoia/src/content/orchestrator.js';

const loadModule = (p) => import(/* @vite-ignore */ `../alcoia/${p}`);

function stubHost(overrides = {}) {
  return {
    sessionTracker: { recordState: vi.fn(), recordSignal: vi.fn() },
    focusRuler: { adaptToState: vi.fn() },
    log: vi.fn(),
    findParagraphAt: vi.fn(async () => null),
    getCurrentParagraph: vi.fn(() => null),
    setCurrentParagraph: vi.fn(),
    setPrevParagraphText: vi.fn(),
    setCogState: vi.fn(),
    onParagraphRead: vi.fn(),
    onStruggle: vi.fn(),
    onQuizOfferEligible: vi.fn(),
    onIntervention: vi.fn(async () => false),
    ...overrides,
  };
}

function stubComprehensionMonitor() {
  return {
    enterParagraph: vi.fn(),
    leaveParagraph: vi.fn(() => null),
    onScroll: vi.fn(() => null),
    resetParagraph: vi.fn(),
  };
}

beforeEach(() => {
  // stateEngine.subscribe() writes sra_current_state on every state change.
  vi.stubGlobal('chrome', { storage: { local: { set: () => {} } } });
});

describe('createOrchestrator(): paragraphTrackerOpts passthrough (item 30c)', () => {
  it('uses an injected blockSource instead of the DOM scan when supplied', async () => {
    const block = { el: { getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }) }, words: 50, media: false };
    const orch = await createOrchestrator({
      loadModule,
      comprehensionMonitor: stubComprehensionMonitor(),
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
      host: stubHost(),
      paragraphTrackerOpts: { blockSource: () => [block] },
    });
    orch.primeParagraph();
    expect(orch.paragraphTracker.count()).toBe(1);
    expect(orch.getActiveParagraphEl()).toBe(block.el);
  });

  it('falls back to the DOM scan (empty here, no real document.body paragraphs) when omitted', async () => {
    document.body.innerHTML = '<div>no p/li/blockquote here</div>';
    const orch = await createOrchestrator({
      loadModule,
      comprehensionMonitor: stubComprehensionMonitor(),
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
      host: stubHost(),
    });
    orch.primeParagraph();
    expect(orch.paragraphTracker.count()).toBe(0);
  });
});

describe('createOrchestrator(): documentKey override (item 30c)', () => {
  it('uses the injected documentKey function instead of coverage-gate.js\'s default', async () => {
    const orch = await createOrchestrator({
      loadModule,
      comprehensionMonitor: stubComprehensionMonitor(),
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
      host: stubHost(),
      documentKey: () => 'pdf:https://example.com/paper.pdf',
    });
    expect(orch.documentKey()).toBe('pdf:https://example.com/paper.pdf');
  });

  it('defaults to coverage-gate.js\'s own hostname+pathname documentKey when omitted', async () => {
    const orch = await createOrchestrator({
      loadModule,
      comprehensionMonitor: stubComprehensionMonitor(),
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
      host: stubHost(),
    });
    const coverageModule = await loadModule('src/content/coverage-gate.js');
    expect(orch.documentKey()).toBe(coverageModule.documentKey());
  });

  it('constructs quiz-offer.js\'s checker with the exact same resolved key function', async () => {
    // Regression guard for the specific bug this option exists to avoid: if
    // coverage recording and the quiz-offer eligibility check used two
    // different key functions, coverage could accumulate under one key
    // while eligibility is checked under another, and "ready" would never
    // fire. Verified by intercepting quiz-offer.js's own constructor call
    // rather than driving a full scroll/coverage scenario end to end — the
    // real module is still used underneath, only the documentKey argument
    // it was actually given is captured.
    const key = 'pdf:https://example.com/paper.pdf';
    let capturedDocumentKey = null;
    const wrappedLoadModule = async (p) => {
      const mod = await loadModule(p);
      if (p === 'src/content/quiz-offer.js') {
        return {
          ...mod,
          createQuizOfferChecker: (opts) => {
            capturedDocumentKey = opts.documentKey;
            return mod.createQuizOfferChecker(opts);
          },
        };
      }
      return mod;
    };
    const orch = await createOrchestrator({
      loadModule: wrappedLoadModule,
      comprehensionMonitor: stubComprehensionMonitor(),
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
      host: stubHost(),
      documentKey: () => key,
    });
    expect(capturedDocumentKey).toBeTypeOf('function');
    expect(capturedDocumentKey()).toBe(key);
    expect(orch.documentKey()).toBe(key);
  });
});

/* host.onStruggle carries substate/selfReported now (13g). host.js just
 * passes these through unchanged (see tests/host.test.js for that half);
 * THIS is the half that proves orchestrator.js itself computes them
 * correctly off a real stateEngine transition — including the
 * 'unclear'-means-no-real-classification translation, which lives here,
 * not in state-engine.js or host.js. */
describe('createOrchestrator(): onStruggle carries substate/selfReported (13g wiring)', () => {
  function hostWithParagraphText(text) {
    return stubHost({ getCurrentParagraph: vi.fn(() => ({ type: 'dom', data: { innerText: text } })) });
  }

  async function makeOrch(host) {
    return createOrchestrator({
      loadModule,
      comprehensionMonitor: stubComprehensionMonitor(),
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
      host,
    });
  }

  it('a self-reported confusion state sends substate:"confusion" and selfReported:true', async () => {
    const host = hostWithParagraphText('some paragraph text');
    const orch = await makeOrch(host);

    orch.stateEngine.update({ reading: { type: 'self_report', subtype: 'confusion' } });
    await vi.waitFor(() => expect(host.onStruggle).toHaveBeenCalled());
    expect(host.onStruggle).toHaveBeenCalledWith('some paragraph text', null, 'confusion', true);
  });

  it('an inferred (non-self-reported) substate — a propositional-density hint clearing the overload bar — sends selfReported:false, distinctly', async () => {
    const host = hostWithParagraphText('some paragraph text');
    const orch = await makeOrch(host);

    orch.stateEngine.update({
      reading: {
        type: 'speed_mismatch', subtype: 'too_slow',
        actualWpm: 90, baselineWpm: 225,
        readability: { syntactic: { score: 90 }, propositional: { score: 20, basis: 'lexical' } },
      },
    });
    await vi.waitFor(() => expect(host.onStruggle).toHaveBeenCalled());
    expect(host.onStruggle).toHaveBeenCalledWith('some paragraph text', null, 'overload', false);
  });

  it('an ordinary struggling signal with nothing clearing a substate bar sends null, not the internal "unclear" default', async () => {
    const host = hostWithParagraphText('some paragraph text');
    const orch = await makeOrch(host);

    orch.stateEngine.update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    await vi.waitFor(() => expect(host.onStruggle).toHaveBeenCalled());
    // Confirms the state engine really did land on 'unclear' internally —
    // the translation to null happens at this call site, not by 'unclear'
    // never occurring in the first place.
    expect(orch.getState().substate).toBe('unclear');
    expect(host.onStruggle).toHaveBeenCalledWith('some paragraph text', null, null, null);
  });
});

/* Step 9A (active intervention awareness) — proves orchestrator.js actually
 * reads host.isQuestionCardVisible() and threads it into
 * interventionPolicy.evaluate()'s ctx, rather than the gate only being
 * exercised at the intervention-policy.js unit level (see that file's own
 * tests for the exhaustive candidate-strength coverage). A response-type
 * signal is used deliberately: it asserts STRUGGLING at 0.95 confidence,
 * clear of every Step 8 evidence-strength/backoff gate on its own, so a
 * denial here can only be explained by the new active-card check. */
describe('createOrchestrator(): host.isQuestionCardVisible() gates onIntervention (step 9A)', () => {
  async function makeOrch(host) {
    return createOrchestrator({
      loadModule,
      comprehensionMonitor: stubComprehensionMonitor(),
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
      host,
    });
  }

  it('dispatches to host.onIntervention when host.isQuestionCardVisible() returns false', async () => {
    const host = stubHost({ isQuestionCardVisible: vi.fn(() => false), onIntervention: vi.fn(async () => true) });
    const orch = await makeOrch(host);

    orch.stateEngine.update({ reading: { type: 'response', subtype: 'incorrect', correct: false } });
    await vi.waitFor(() => expect(host.onIntervention).toHaveBeenCalled());
    expect(host.isQuestionCardVisible).toHaveBeenCalled();
  });

  it('does NOT dispatch to host.onIntervention when host.isQuestionCardVisible() returns true', async () => {
    const host = stubHost({ isQuestionCardVisible: vi.fn(() => true), onIntervention: vi.fn(async () => true) });
    const orch = await makeOrch(host);

    orch.stateEngine.update({ reading: { type: 'response', subtype: 'incorrect', correct: false } });
    await vi.waitFor(() => expect(host.isQuestionCardVisible).toHaveBeenCalled());
    expect(host.onIntervention).not.toHaveBeenCalled();
  });

  it('treats a host with no isQuestionCardVisible callback at all as "not visible" — backward compatible with every stub that predates this item', async () => {
    const host = stubHost({ onIntervention: vi.fn(async () => true) });
    expect(host.isQuestionCardVisible).toBeUndefined();
    const orch = await makeOrch(host);

    orch.stateEngine.update({ reading: { type: 'response', subtype: 'incorrect', correct: false } });
    await vi.waitFor(() => expect(host.onIntervention).toHaveBeenCalled());
  });
});
