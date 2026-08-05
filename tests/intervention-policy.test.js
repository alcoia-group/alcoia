import { describe, it, expect } from 'vitest';
import { createInterventionPolicy, STATE_ACTIONS } from '../TL_DR/src/content/intervention-policy.js';
import { STATES } from '../TL_DR/src/content/state-engine.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const struggling = (over = {}) => ({
  label: STATES.STRUGGLING,
  confidence: 0.7,
  evidence: ['You slowed down a lot here'],
  signal: { text: 'paragraph one' },
  ...over,
});

/* Accept a decision and consume the budget, the way the caller must. */
function take(policy, state, ctx) {
  const d = policy.evaluate(state, ctx);
  policy.record(d);
  return d;
}

describe('what earns an interruption', () => {
  it('never interrupts on unknown', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate({ label: STATES.UNKNOWN, confidence: 0.9, evidence: [] });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/unknown/);
  });

  it.each([STATES.ON_PACE, STATES.ABSENT])('takes no action on %s', (label) => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    expect(STATE_ACTIONS[label]).toBe('none');
    expect(p.evaluate({ label, confidence: 0.9, evidence: [] }).allow).toBe(false);
  });

  /* Questions, not summaries. Summarising removes the desirable difficulty
   * that produces retention, and an answer is the only thing in this system
   * that produces ground truth. Explanation is the fallback after a wrong
   * answer, or when no question could be generated for the passage. */
  it('asks a question when struggling rather than summarising', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling());
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
  });

  it('asks rather than summarising on dense skimmed text too', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate({
      label: STATES.SKIMMING, confidence: 0.6, evidence: [],
      signal: { text: 'p', readability: { grade: 'difficult' } },
    });
    expect(d.action).toBe('ask');
  });

  it('declines below the confidence floor', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling({ confidence: 0.3 }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/confidence/);
  });

  it('carries evidence the reader can see', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    expect(p.evaluate(struggling()).evidence).toEqual(['You slowed down a lot here']);
  });
});

describe('skimming is only worth interrupting over dense text', () => {
  const skim = (grade) => ({
    label: STATES.SKIMMING, confidence: 0.6, evidence: [],
    signal: { text: 'p', readability: { grade } },
  });

  it.each(['easy', 'standard'])('declines on %s text', (grade) => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    expect(p.evaluate(skim(grade)).allow).toBe(false);
  });

  it.each(['difficult', 'very_difficult'])('allows on %s text', (grade) => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    expect(p.evaluate(skim(grade)).allow).toBe(true);
  });
});

describe('budget', () => {
  it('enforces three minutes between interruptions', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });

    expect(take(p, struggling({ signal: { text: 'a' } })).allow).toBe(true);

    clock.advance(60_000);
    const tooSoon = p.evaluate(struggling({ signal: { text: 'b' } }));
    expect(tooSoon.allow).toBe(false);
    expect(tooSoon.reason).toMatch(/since the last interruption/);

    clock.advance(121_000);
    expect(p.evaluate(struggling({ signal: { text: 'b' } })).allow).toBe(true);
  });

  it('stops after five in a session', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });

    for (let i = 0; i < 5; i++) {
      const d = take(p, struggling({ signal: { text: `para ${i}` } }));
      expect(d.allow).toBe(true);
      clock.advance(200_000);
    }

    expect(p.stats().remaining).toBe(0);
    const sixth = p.evaluate(struggling({ signal: { text: 'para 6' } }));
    expect(sixth.allow).toBe(false);
    expect(sixth.reason).toMatch(/session budget/);
  });

  it('never interrupts twice on the same paragraph', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });

    expect(take(p, struggling({ signal: { text: 'the same paragraph' } })).allow).toBe(true);
    clock.advance(600_000);

    const again = p.evaluate(struggling({ signal: { text: 'the same paragraph' } }));
    expect(again.allow).toBe(false);
    expect(again.reason).toMatch(/already interrupted/);
  });

  it('falls back to the current element for the paragraph key', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });
    const el = { innerText: 'element-derived paragraph text' };
    const state = { label: STATES.STRUGGLING, confidence: 0.7, evidence: [], signal: null };

    expect(take(p, state, { currentEl: el }).allow).toBe(true);
    clock.advance(600_000);
    expect(p.evaluate(state, { currentEl: el }).allow).toBe(false);
  });

  it('does not spend budget on a decision that was never recorded', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });

    // Evaluated but dropped downstream — e.g. the paragraph left the viewport.
    p.evaluate(struggling({ signal: { text: 'a' } }));
    p.evaluate(struggling({ signal: { text: 'b' } }));
    expect(p.stats().count).toBe(0);

    expect(take(p, struggling({ signal: { text: 'c' } })).allow).toBe(true);
    expect(p.stats().count).toBe(1);
  });

  it('resets', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });
    take(p, struggling({ signal: { text: 'a' } }));
    p.reset();
    expect(p.stats().count).toBe(0);
    expect(p.evaluate(struggling({ signal: { text: 'a' } })).allow).toBe(true);
  });
});
