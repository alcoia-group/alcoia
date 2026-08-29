import { describe, it, expect } from 'vitest';
import { createInterventionPolicy, STATE_ACTIONS, EXPLORATION_SAMPLE_RATE } from '../alcoia/src/content/intervention-policy.js';
import { STATES } from '../alcoia/src/content/state-engine.js';

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
    // random: () => 1 disables exploration sampling — that mechanism is
    // covered on its own further down; this test is about the base table.
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 1 });
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

describe('the session cap scales with content read', () => {
  it('starts at the base allowance with nothing read yet', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    expect(p.stats().cap).toBe(5);
  });

  it('reading tracked prose paragraphs earns more interruptions', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    for (let i = 0; i < 8; i++) p.recordCoverage({ words: 120, dwellMs: 1000 });
    // 8 paragraphs / 4-per-unit = 2 units earned on top of the base of 5.
    expect(p.stats().cap).toBe(7);
  });

  it('measured reading time alone also earns more interruptions', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordCoverage({ words: 0, dwellMs: 9 * 60000 }); // 9 minutes, no paragraph counted
    // 9 minutes / 3-per-unit = 3 units.
    expect(p.stats().cap).toBe(8);
  });

  it('media landmarks (figures, tables) never count toward the cap', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    for (let i = 0; i < 20; i++) p.recordCoverage({ words: 0, dwellMs: 5000, media: true });
    expect(p.stats().cap).toBe(5);
    expect(p.stats().paragraphsRead).toBe(0);
    expect(p.stats().msRead).toBe(0);
  });

  it('is clamped at the absolute ceiling however much is read', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    for (let i = 0; i < 400; i++) p.recordCoverage({ words: 120, dwellMs: 60000 });
    expect(p.stats().cap).toBe(25);
    expect(p.stats().absoluteCeiling).toBe(25);
  });

  it('a session that has read more actually gets to interrupt more than one that has read less', () => {
    const clock = fixedClock();
    const short = createInterventionPolicy({ now: clock.now });
    const long  = createInterventionPolicy({ now: clock.now });
    for (let i = 0; i < 40; i++) long.recordCoverage({ words: 120, dwellMs: 60000 });

    let shortAllowed = 0, longAllowed = 0;
    for (let i = 0; i < 15; i++) {
      if (take(short, struggling({ signal: { text: `s${i}` } })).allow) shortAllowed++;
      if (take(long,  struggling({ signal: { text: `l${i}` } })).allow) longAllowed++;
      clock.advance(200_000);
    }
    expect(longAllowed).toBeGreaterThan(shortAllowed);
    expect(shortAllowed).toBe(5);
  });

  it('honours a configured budget override for the scaling constants', () => {
    const p = createInterventionPolicy({
      now: fixedClock().now,
      budget: { baseAllowance: 1, paragraphsPerUnit: 1, absoluteCeiling: 3 },
    });
    p.recordCoverage({ words: 50, dwellMs: 1000 });
    p.recordCoverage({ words: 50, dwellMs: 1000 });
    expect(p.stats().cap).toBe(3); // 1 base + 2 units, clamped at ceiling 3
  });
});

describe('dismissal-aware backoff', () => {
  const dense = (over = {}) => struggling({ signal: { text: 'dense text' }, ...over });

  it('does not affect the first two dismissals', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordDismissal();
    expect(p.evaluate(dense()).allow).toBe(true);
  });

  it('raises the confidence bar on the second consecutive dismissal', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordDismissal();
    p.recordDismissal();
    const lowConf = p.evaluate(struggling({ confidence: 0.6, signal: { text: 'x' } }));
    expect(lowConf.allow).toBe(false);
    expect(lowConf.reason).toMatch(/raised bar/);

    const highConf = p.evaluate(struggling({ confidence: 0.8, signal: { text: 'x' } }));
    expect(highConf.allow).toBe(true);
  });

  it('stops asking outright after three consecutive dismissals, even at high confidence', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordDismissal();
    p.recordDismissal();
    p.recordDismissal();
    const d = p.evaluate(struggling({ confidence: 0.99, signal: { text: 'x' } }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/holding off/);
  });

  it('does not touch nudge actions (drifting readers are not being tested)', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordDismissal();
    p.recordDismissal();
    p.recordDismissal();
    const d = p.evaluate({ label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting' } });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('nudge');
  });

  it('any answer, right or wrong, clears the backoff', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordDismissal();
    p.recordDismissal();
    p.recordDismissal();
    expect(p.evaluate(dense()).allow).toBe(false);

    p.recordAnswered();
    expect(p.evaluate(dense()).allow).toBe(true);
  });

  it('reports the running count in stats', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordDismissal();
    p.recordDismissal();
    expect(p.stats().consecutiveDismissals).toBe(2);
    p.recordAnswered();
    expect(p.stats().consecutiveDismissals).toBe(0);
  });
});

/* Labels collected so far all come from paragraphs the state machine already
 * flagged. Exploration sampling asks anyway on a slice of paragraphs the
 * detector would have left alone, so the resulting labels aren't conditioned
 * on the detector's own decision. See CLAUDE.md. */
describe('exploration sampling', () => {
  const onPace = (over = {}) => ({
    label: STATES.ON_PACE, confidence: 0.9, evidence: [],
    signal: { text: 'an on-pace paragraph' },
    ...over,
  });

  it('the rate is a named constant in the 10-15% band', () => {
    expect(EXPLORATION_SAMPLE_RATE).toBeGreaterThanOrEqual(0.10);
    expect(EXPLORATION_SAMPLE_RATE).toBeLessThanOrEqual(0.15);
  });

  it('samples when the injected RNG lands under the rate', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => EXPLORATION_SAMPLE_RATE - 0.01 });
    const d = p.evaluate(onPace());
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
    expect(d.wasExplorationSample).toBe(true);
  });

  it('declines to sample when the injected RNG lands over the rate', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => EXPLORATION_SAMPLE_RATE + 0.01 });
    const d = p.evaluate(onPace());
    expect(d.allow).toBe(false);
    expect(d.wasExplorationSample).toBe(false);
  });

  it('fires on a paragraph whose state is on_pace', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const d = p.evaluate(onPace());
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
    expect(d.wasExplorationSample).toBe(true);
  });

  it('never fires on a drifting reader, even when the RNG would sample', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const d = p.evaluate({ label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting para' } });
    expect(d.wasExplorationSample).toBe(false);
    expect(d.action).not.toBe('ask');
  });

  it('never fires on an absent reader, even when the RNG would sample', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const d = p.evaluate({ label: STATES.ABSENT, confidence: 0.9, evidence: [] });
    expect(d.allow).toBe(false);
    expect(d.wasExplorationSample).toBe(false);
  });

  it('still respects the confidence floor', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const d = p.evaluate(onPace({ confidence: 0.3 }));
    expect(d.allow).toBe(false);
  });

  it('still respects the 3-minute gap and spends the budget like any interruption', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, random: () => 0 });

    const first = take(p, onPace({ signal: { text: 'a' } }));
    expect(first.allow).toBe(true);
    expect(p.stats().count).toBe(1);

    clock.advance(60_000);
    const tooSoon = p.evaluate(onPace({ signal: { text: 'b' } }));
    expect(tooSoon.allow).toBe(false);
  });

  it('still never interrupts twice on the same paragraph', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, random: () => 0 });
    const state = onPace({ signal: { text: 'the same on-pace paragraph' } });

    expect(take(p, state).allow).toBe(true);
    clock.advance(600_000);
    expect(p.evaluate(state).allow).toBe(false);
  });

  it('does not tag a normal struggling ask as an exploration sample', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const d = p.evaluate(struggling());
    expect(d.allow).toBe(true);
    expect(d.wasExplorationSample).toBe(false);
  });
});

/* Item 13a: state-engine.js now emits an additive `substate` field
 * alongside `label` whenever the state is struggling. This file's own
 * evaluate()/STATE_ACTIONS/every other branch must stay byte-for-byte
 * unchanged — confirmed here directly with a state object carrying the
 * new field, not just inferred from "we didn't edit this file." */
describe('substate (item 13a) is inert here — this file never reads it', () => {
  it('a struggling state with substate: "unclear" behaves identically to one with no substate at all', () => {
    const p1 = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const p2 = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const withSubstate = p1.evaluate(struggling({ substate: 'unclear' }));
    const without = p2.evaluate(struggling());
    expect(withSubstate).toEqual(without);
  });

  it('a struggling state with substate: "confusion" or "overload" is evaluated exactly the same way — this file does not branch on it', () => {
    const base = createInterventionPolicy({ now: fixedClock().now, random: () => 0 }).evaluate(struggling());
    for (const substate of ['confusion', 'overload', null, undefined]) {
      const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
      expect(p.evaluate(struggling({ substate }))).toEqual(base);
    }
  });
});
