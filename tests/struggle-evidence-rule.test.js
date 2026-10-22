// @vitest-environment jsdom
/* Two pieces of evidence before a struggle question: one slow paragraph alone changes nothing. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStruggleEvidenceRule, STRUGGLE_EVIDENCE } from '../alcoia/src/content/signals/struggle-evidence-rule.js';
import { createOrchestrator } from '../alcoia/src/content/orchestrator.js';

const slow = (el = {}) => ({ type: 'speed_mismatch', subtype: 'too_slow', el, readability: { propositional: { score: 90 } } });
const reread = (subtype = 'return') => ({ type: 'regression', subtype, distance: 1, sameIndexRereadCount: 1 });

function rule(extra = {}) {
  let t = 0;
  const r = createStruggleEvidenceRule({ now: () => t, ...extra });
  return { r, at: (ms) => { t = ms; } };
}

describe('struggle evidence rule', () => {
  it('holds a single slow paragraph: nothing reaches the state engine', () => {
    const h = rule();
    expect(h.r.filter([slow()])).toEqual([]);
    expect(h.r.hasHeld()).toBe(true);
  });

  it('releases it when a genuine re-read follows, together with the re-read', () => {
    const h = rule();
    h.r.filter([slow()]);
    h.at(30000);
    const out = h.r.filter([reread('return')]);
    expect(out).toHaveLength(2);
    expect(out[0].subtype).toBe('too_slow');
    expect(out[0].corroboratedBy).toBe(STRUGGLE_EVIDENCE.SLOW_THEN_REREAD);
    expect(out[1].type).toBe('regression');
    expect(h.r.hasHeld()).toBe(false);
  });

  it('also works when the slow paragraph and the re-read arrive in the same batch', () => {
    const h = rule();
    const out = h.r.filter([reread('fast_return'), slow()]);
    expect(out.map((s) => s.type)).toEqual(['speed_mismatch', 'regression']);
  });

  it('releases the second of two slow paragraphs in a row', () => {
    const h = rule();
    h.r.filter([slow({ id: 1 })]);
    h.at(40000);
    const out = h.r.filter([slow({ id: 2 })]);
    expect(out).toHaveLength(1);
    expect(out[0].corroboratedBy).toBe(STRUGGLE_EVIDENCE.TWO_SLOW_IN_A_ROW);
  });

  it('the same paragraph being slow twice is not two paragraphs', () => {
    const h = rule();
    const same = {};
    h.r.filter([slow(same)]);
    h.at(10000);
    expect(h.r.filter([slow(same)])).toEqual([]);
  });

  it('forgets a slow paragraph once the window has passed', () => {
    const h = rule();
    h.r.filter([slow()]);
    h.at(STRUGGLE_EVIDENCE.WINDOW_MS + 1);
    expect(h.r.filter([reread('return')]).map((s) => s.type)).toEqual(['regression']);
    expect(h.r.hasHeld()).toBe(false);
  });

  it('a slow return (deliberate review) is not a re-read that corroborates', () => {
    const h = rule();
    h.r.filter([slow()]);
    h.at(5000);
    const out = h.r.filter([reread('slow_return')]);
    expect(out.map((s) => s.type)).toEqual(['regression']);
    expect(h.r.hasHeld()).toBe(true);
  });

  it('lets everything else through untouched: self-report, backtrack, a lone confirmed re-read', () => {
    const h = rule();
    const batch = [{ type: 'self_report', subtype: 'confused' }, { type: 'backtrack', backtrackPx: 300 }, reread('return')];
    expect(h.r.filter(batch)).toEqual(batch);
  });

  it('can be switched off', () => {
    const h = rule({ enabled: false });
    const s = slow();
    expect(h.r.filter([s])).toEqual([s]);
  });
});

describe('through the orchestrator', () => {
  const loadModule = (p) => import(/* @vite-ignore */ `../alcoia/${p}`);
  const host = () => ({
    sessionTracker: { recordState: vi.fn(), recordSignal: vi.fn() }, focusRuler: { adaptToState: vi.fn() }, log: vi.fn(),
    findParagraphAt: vi.fn(async () => null), getCurrentParagraph: vi.fn(() => null), setCurrentParagraph: vi.fn(),
    setPrevParagraphText: vi.fn(), setCogState: vi.fn(), onParagraphRead: vi.fn(), onStruggle: vi.fn(),
    onQuizOfferEligible: vi.fn(), onIntervention: vi.fn(async () => false),
  });
  const monitor = () => ({ enterParagraph: vi.fn(), leaveParagraph: vi.fn(() => null), onScroll: vi.fn(() => null), resetParagraph: vi.fn() });
  beforeEach(() => { vi.stubGlobal('chrome', { storage: { local: { set: () => {} } } }); });
  const make = (extra = {}) => createOrchestrator({
    loadModule, comprehensionMonitor: monitor(), host: host(),
    settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, focusRulerEnabled: false, debugEnabled: false }),
    ...extra,
  });

  it('one too-slow paragraph leaves the reading state unchanged; two in a row make it struggling', async () => {
    const orch = await make();
    orch.pumpSignals(slow({ id: 1 }));
    expect(orch.getState().label).not.toBe('struggling');
    orch.pumpSignals(slow({ id: 2 }));
    expect(orch.getState().label).toBe('struggling');
    orch.stop();
  });

  it('with the rule switched off a single too-slow paragraph is struggling, as before', async () => {
    const orch = await make({ evidenceRuleOpts: { enabled: false } });
    orch.pumpSignals(slow({ id: 1 }));
    expect(orch.getState().label).toBe('struggling');
    orch.stop();
  });
});
