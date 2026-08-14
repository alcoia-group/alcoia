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
