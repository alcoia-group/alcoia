// @vitest-environment jsdom
/* Passive away detection. Away is not a reading state: it is never a struggle
 * signal, it pauses dwell and pace measurement, and nothing interrupts while it
 * lasts. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAwayDetector, AWAY_HIDDEN_MS, AWAY_IDLE_MS,
} from '../alcoia/src/content/signals/away-detector.js';
import { createReadingStateEngine, STATES } from '../alcoia/src/content/state-engine.js';
import { createInterventionPolicy, STATE_ACTIONS } from '../alcoia/src/content/intervention-policy.js';
import { createParagraphTracker } from '../alcoia/src/content/signals/paragraph-tracker.js';
import { createOrchestrator } from '../alcoia/src/content/orchestrator.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('away detector', () => {
  it('is not away for a short hide', () => {
    const c = clock();
    const d = createAwayDetector({ now: c.now });
    d.event('hidden');
    c.advance(AWAY_HIDDEN_MS - 1000);
    expect(d.poll()).toBeNull();
    expect(d.isAway()).toBe(false);
    expect(d.event('visible')).toBeNull();
  });

  it('is away once hidden past the threshold, and reports the time away on return', () => {
    const c = clock();
    const d = createAwayDetector({ now: c.now });
    d.event('hidden');
    c.advance(AWAY_HIDDEN_MS + 5000);
    expect(d.poll()).toMatchObject({ type: 'away_start' });
    expect(d.isAway()).toBe(true);
    c.advance(120000);
    const end = d.event('visible');
    expect(end.type).toBe('away_end');
    expect(end.awayMs).toBe(AWAY_HIDDEN_MS + 5000 + 120000);
    expect(d.isAway()).toBe(false);
  });

  it('notices a long absence on return even if no timer ran (throttled background tab)', () => {
    const c = clock();
    const d = createAwayDetector({ now: c.now });
    d.event('blur');
    c.advance(10 * 60 * 1000);
    const end = d.event('focus');
    expect(end.type).toBe('away_end');
    expect(end.awayMs).toBe(10 * 60 * 1000);
  });

  it('input while the window is unfocused restarts the clock', () => {
    const c = clock();
    const d = createAwayDetector({ now: c.now });
    d.event('blur');
    c.advance(AWAY_HIDDEN_MS - 1000);
    d.event('input');
    c.advance(AWAY_HIDDEN_MS - 1000);
    expect(d.poll()).toBeNull();
  });

  it('a visible, focused page is away only after the longer idle threshold, and any input ends it', () => {
    const c = clock();
    const d = createAwayDetector({ now: c.now });
    c.advance(AWAY_HIDDEN_MS * 3);
    expect(d.poll()).toBeNull();
    c.advance(AWAY_IDLE_MS);
    expect(d.poll()).toMatchObject({ type: 'away_start' });
    const end = d.event('input');
    expect(end.type).toBe('away_end');
    expect(end.awayMs).toBeGreaterThanOrEqual(AWAY_IDLE_MS);
  });
});

describe('state engine and policy', () => {
  it('away is its own state, not a struggle', () => {
    const e = createReadingStateEngine();
    const s = e.update({ reading: [{ type: 'away', assertable: true }] });
    expect(s.label).toBe(STATES.AWAY);
    expect(s.label).not.toBe(STATES.STRUGGLING);
    expect(s.substate).toBeNull();
    expect(s.isSelfReported).toBe(false);
    expect(s.evidence.join(' ')).not.toMatch(/struggl|slow|confus/i);
  });

  it('away wins over reading signals batched with it', () => {
    const e = createReadingStateEngine();
    const s = e.update({ reading: [
      { type: 'speed_mismatch', subtype: 'too_slow', actualWpm: 30, baselineWpm: 225, readability: { grade: 'standard' } },
      { type: 'away', assertable: true },
    ] });
    expect(s.label).toBe(STATES.AWAY);
  });

  it('the engine returns to unknown when away ends', () => {
    const e = createReadingStateEngine();
    e.update({ reading: [{ type: 'away', assertable: true }] });
    expect(e.update({ reading: [] }).label).toBe(STATES.UNKNOWN);
  });

  it('the policy never interrupts, and spends nothing, while away', () => {
    const p = createInterventionPolicy();
    expect(STATE_ACTIONS[STATES.AWAY]).toBe('none');
    const d = p.evaluate({ label: STATES.AWAY, confidence: 0.97, evidence: [] });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('reader is away');
  });
});

describe('dwell is not inflated by time away', () => {
  it('shiftTime removes the away interval from the paragraph dwell', () => {
    const c = clock();
    const el = { getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }) };
    const el2 = { getBoundingClientRect: () => ({ top: 5000, bottom: 5100, height: 100 }) };
    let which = el;
    const tracker = createParagraphTracker({
      now: c.now, minWords: 1,
      blockSource: () => [{ el: which, words: 50, media: false }],
    });
    tracker.update();
    c.advance(20000);
    c.advance(15 * 60 * 1000);
    tracker.shiftTime(15 * 60 * 1000);
    which = el2;
    tracker.rescan();
    const t = tracker.update();
    expect(t?.left?.dwellMs).toBe(20000);
  });
});

describe('orchestrator wiring', () => {
  const loadModule = (p) => import(/* @vite-ignore */ `../alcoia/${p}`);
  beforeEach(() => { vi.stubGlobal('chrome', { storage: { local: { set: () => {} } } }); });

  async function build(c, hostOver = {}) {
    const monitor = {
      enterParagraph: vi.fn(), leaveParagraph: vi.fn(() => null), onScroll: vi.fn(() => null),
      resetParagraph: vi.fn(), shiftTime: vi.fn(),
    };
    const host = {
      sessionTracker: { recordState: vi.fn(), recordSignal: vi.fn() },
      log: vi.fn(), findParagraphAt: vi.fn(async () => null),
      getCurrentParagraph: vi.fn(() => null), setCurrentParagraph: vi.fn(),
      setPrevParagraphText: vi.fn(), setCogState: vi.fn(), onParagraphRead: vi.fn(),
      onStruggle: vi.fn(), onQuizOfferEligible: vi.fn(), onIntervention: vi.fn(async () => true),
      onReturnCheck: vi.fn(), logDecision: vi.fn(),
      ...hostOver,
    };
    const orch = await createOrchestrator({
      loadModule, comprehensionMonitor: monitor, host,
      settings: () => ({ assistantEnabled: true, comprehensionCheckEnabled: true, debugEnabled: false }),
      awayOpts: { now: c.now },
      paragraphTrackerOpts: { now: c.now, blockSource: () => [] },
    });
    return { orch, monitor, host };
  }

  it('away puts the engine in the away state, never struggling, with no struggle outcome or intervention', async () => {
    const c = clock();
    const { orch, host } = await build(c);
    orch.awayDetector.event('hidden');
    c.advance(AWAY_HIDDEN_MS + 1000);
    orch.handleAway(orch.awayDetector.poll());
    expect(orch.isAway()).toBe(true);
    expect(orch.getState().label).toBe('away');
    expect(host.onStruggle).not.toHaveBeenCalled();
    expect(host.onIntervention).not.toHaveBeenCalled();
  });

  it('pumpSignals while away does not move the state engine', async () => {
    const c = clock();
    const { orch } = await build(c);
    orch.awayDetector.event('hidden');
    c.advance(AWAY_HIDDEN_MS + 1000);
    orch.handleAway(orch.awayDetector.poll());
    orch.pumpSignals({ type: 'speed_mismatch', subtype: 'too_slow', actualWpm: 20, baselineWpm: 225, readability: { grade: 'standard' } });
    expect(orch.getState().label).toBe('away');
  });

  it('on return the pace timer is moved forward by the time away and the state leaves away', async () => {
    const c = clock();
    const { orch, monitor } = await build(c);
    orch.awayDetector.event('blur');
    c.advance(AWAY_HIDDEN_MS + 1000);
    orch.handleAway(orch.awayDetector.poll());
    c.advance(5 * 60 * 1000);
    orch.handleAway(orch.awayDetector.event('focus'));
    expect(orch.isAway()).toBe(false);
    expect(monitor.shiftTime).toHaveBeenCalledWith(AWAY_HIDDEN_MS + 1000 + 5 * 60 * 1000);
    expect(orch.getState().label).toBe('unknown');
  });

  it('listeners: a hidden tab then a visible tab runs the whole cycle through real events', async () => {
    const c = clock();
    const { orch, monitor } = await build(c);
    const ac = new AbortController();
    orch.installListeners(ac.signal);
    const setVis = (v) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    setVis('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    c.advance(AWAY_HIDDEN_MS + 2000);
    orch.handleAway(orch.awayDetector.poll());
    expect(orch.getState().label).toBe('away');
    c.advance(60000);
    setVis('visible'); document.dispatchEvent(new Event('visibilitychange'));
    expect(orch.isAway()).toBe(false);
    expect(monitor.shiftTime).toHaveBeenCalled();
    ac.abort(); orch.stop();
  });
});
