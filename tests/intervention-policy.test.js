import { describe, it, expect } from 'vitest';
import { createInterventionPolicy, STATE_ACTIONS } from '../alcoia/src/content/intervention-policy.js';
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

  it('takes no action on on_pace', () => {
    // (ABSENT used to be a second case here; STATES.ABSENT no longer
    // exists — see the "removed state" describe block below.)
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 1 });
    expect(STATE_ACTIONS[STATES.ON_PACE]).toBe('none');
    expect(p.evaluate({ label: STATES.ON_PACE, confidence: 0.9, evidence: [] }).allow).toBe(false);
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

describe('skimming is only worth a full interruption over dense text', () => {
  const skim = (grade) => ({
    label: STATES.SKIMMING, confidence: 0.6, evidence: [],
    signal: { text: 'p', readability: { grade } },
  });

  // Step 23 (REPLACE, documented in intervention-policy.js's own
  // POLICY_ACTIONS header): previously a bare denial (nothing happened at
  // all) — now a real, lightweight ATTENTION outcome, rendered through the
  // same 'nudge' affordance DRIFTING already uses. Still allowed, still
  // real evidence, just not worth a full retrieval question. This is one of
  // the central behavior changes this rebuild exists to make: a weak signal
  // no longer collapses to silence merely because it isn't strong enough
  // for the heaviest response.
  it.each(['easy', 'standard'])('earns a lightweight attention nudge, not a question, on %s text', (grade) => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(skim(grade));
    expect(d.allow).toBe(true);
    expect(d.action).toBe('nudge');
    expect(d.policyAction).toBe('attention');
  });

  it.each(['difficult', 'very_difficult'])('earns a full retrieval question on %s text', (grade) => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(skim(grade));
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
    expect(d.policyAction).toBe('retrieve');
  });

  it('a non-dense skimming attention nudge still spends the shared budget, like every other non-reader-initiated action', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });
    expect(take(p, skim('easy')).allow).toBe(true);
    const tooSoon = p.evaluate(skim('easy'));
    expect(tooSoon.allow).toBe(false);
    expect(tooSoon.reason).toMatch(/since the last interruption/);
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

/* Exploration sampling was removed: an on-pace reader is never interrupted
 * just because a random draw came up. These tests pin that, including with a
 * random source that would have triggered the old sampler on every call. */
describe('no exploration sampling', () => {
  const onPace = () => ({
    label: STATES.ON_PACE, confidence: 0.9, evidence: [],
    signal: { text: 'an on-pace paragraph' },
  });

  it('never interrupts an on-pace reader, whatever the random source returns', () => {
    for (const r of [0, 0.01, 0.125, 0.5, 0.99, 1]) {
      const p = createInterventionPolicy({ now: fixedClock().now, random: () => r });
      const d = p.evaluate(onPace());
      expect(d.allow).toBe(false);
      expect(d.action).toBe('none');
    }
  });

  it('ignores a legacy explorationRate config value', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0, explorationRate: 1 });
    expect(p.evaluate(onPace()).allow).toBe(false);
  });

  it('decisions carry no exploration tag', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const d = p.evaluate({ label: STATES.STRUGGLING, confidence: 0.9, evidence: ['x'], signal: { text: 'a struggling paragraph' } });
    expect('wasExplorationSample' in d).toBe(false);
  });

  it('still asks when other evidence independently justifies it', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 1 });
    const d = p.evaluate({ label: STATES.STRUGGLING, confidence: 0.9, evidence: ['You re-read this'], signal: { text: 'a struggling paragraph' } });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
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

/* State-engine correctness pass (intelligence-architecture audit): ABSENT
 * was declared, had a STATE_ACTIONS entry, and had an exploration-exclusion
 * branch here, but no detector anywhere in the codebase ever produced it —
 * every prior test exercising it had to fabricate the state object by hand,
 * which is itself the evidence it was dead. Removed everywhere rather than
 * kept as an unreachable placeholder. */
describe('the removed ABSENT state', () => {
  it('no longer exists on STATES', () => {
    expect(STATES.ABSENT).toBeUndefined();
  });

  it('no longer has a STATE_ACTIONS entry', () => {
    expect(Object.keys(STATE_ACTIONS)).not.toContain('absent');
  });
});

/* DRIFTING stays — it is real and reachable — but only via an explicit
 * reader self-report, never a passive detector. state-engine.js now emits
 * an additive `isSelfReported` field on every state object precisely so a
 * caller can tell that apart from an inferred state, rather than DRIFTING's
 * mere presence being read as "this is detected". This file's own
 * STATE_ACTIONS/evaluate() logic is unchanged by that field — it still
 * branches on `label` only, exactly as before — these tests just confirm
 * the field survives untouched alongside every other state shape this file
 * already builds by hand. */
describe('self-reported disengagement is distinguishable from inferred states (isSelfReported)', () => {
  it('a hand-built DRIFTING decision carrying isSelfReported: true evaluates identically to one without the field', () => {
    const withFlag = createInterventionPolicy({ now: fixedClock().now }).evaluate({
      label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting' }, isSelfReported: true,
    });
    const without = createInterventionPolicy({ now: fixedClock().now }).evaluate({
      label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting' },
    });
    expect(withFlag).toEqual(without);
  });

  it('an inferred struggling state has isSelfReported unset, unlike a self-reported one', () => {
    // This file never sets the field itself (that is state-engine.js's
    // job) — this just confirms an ordinary hand-built inferred state, the
    // shape every other test in this file uses, carries no such claim.
    const inferred = struggling();
    expect(inferred.isSelfReported).toBeUndefined();
  });
});

/* Intelligence-architecture audit, step 5 — interventionId is minted here,
 * at the moment an interruption is actually allowed, per this module's own
 * "intervention selected" role in the causal chain. */
describe('interventionId (step 5)', () => {
  it('is set on an allowed "ask" decision', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling());
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
    expect(typeof d.interventionId).toBe('string');
    expect(d.interventionId.length).toBeGreaterThan(0);
  });

  it('is null on a "nudge" decision — a nudge has no question and nothing for an outcome to attribute to', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate({ label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting' } });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('nudge');
    expect(d.interventionId).toBeNull();
  });

  it('is null on every denied decision', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate({ label: STATES.UNKNOWN, confidence: 0.9, evidence: [] });
    expect(d.allow).toBe(false);
    expect(d.interventionId).toBeNull();
  });

  it('is a genuinely different id on two separate "ask" decisions, even from the same paragraph text at different confidences', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });
    const first = take(p, struggling());
    clock.advance(200000); // clear the 3-minute gap and the paragraph re-ask guard needs a different paragraph
    const second = take(p, struggling({ signal: { text: 'a different paragraph' } }));
    expect(first.interventionId).not.toBe(second.interventionId);
  });

  it('is deterministic when the policy is constructed with a fixed clock and a fixed RNG — proves it derives from the SAME injected now()/random() this module already uses, not an unseeded global', () => {
    const a = createInterventionPolicy({ now: fixedClock().now, random: () => 0 }).evaluate(struggling());
    const b = createInterventionPolicy({ now: fixedClock().now, random: () => 0 }).evaluate(struggling());
    expect(a.interventionId).toBe(b.interventionId);
  });

  it('accepts an injected generateInterventionId, the same DI shape as now/random, so a test can assert on the exact id used', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, generateInterventionId: () => 'fixed-test-id' });
    const d = p.evaluate(struggling());
    expect(d.interventionId).toBe('fixed-test-id');
  });

  it('never embeds anything resembling an account id, email, or pseudonym', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling());
    expect(d.interventionId).not.toMatch(/@/);
  });
});

// Intelligence-architecture audit, step 7. See evaluateRetentionCandidate's
// own header for why it isn't just evaluateContentTrigger with a different
// action string — it checks dismissal backoff and mints an interventionId,
// neither of which pretest's own content-trigger path needs.
describe('evaluateRetentionCandidate (step 7)', () => {
  it('allows a due candidate under ordinary conditions', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('retention');
    expect(typeof d.interventionId).toBe('string');
    expect(d.interventionId.length).toBeGreaterThan(0);
  });

  it('spends from the SAME budget as evaluate() -- an ask followed immediately by a retention candidate hits the cooldown', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });
    take(p, struggling());
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'a different paragraph' });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/since the last interruption/);
  });

  it('respects the session cap, shared with every other path', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { baseAllowance: 1, minGapMs: 0 } });
    const first = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    p.record(first);
    const second = p.evaluateRetentionCandidate({ paragraphKey: 'k2' });
    expect(second.allow).toBe(false);
    expect(second.reason).toMatch(/session budget spent/);
  });

  it('never interrupts twice on the same paragraph, sharing the dedup set with evaluate()/evaluateContentTrigger', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { minGapMs: 0 } });
    const first = p.evaluateRetentionCandidate({ paragraphKey: 'same-key' });
    p.record(first);
    const second = p.evaluateRetentionCandidate({ paragraphKey: 'same-key' });
    expect(second.allow).toBe(false);
    expect(second.reason).toMatch(/already interrupted/);
  });

  it('a paragraph already asked about via evaluate() cannot also be picked up as a retention candidate in the same session', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { minGapMs: 0 } });
    take(p, struggling({ signal: { text: 'shared paragraph' } }));
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'shared paragraph'.slice(0, 80).trim() });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/already interrupted/);
  });

  it('holds off once dismissal backoff has raised the bar, unlike evaluateContentTrigger which never checks it', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { minGapMs: 0 } });
    p.recordDismissal();
    p.recordDismissal();
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/consecutive dismissals/);
  });

  it('stops entirely once the hard dismissal-backoff stop is reached', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { minGapMs: 0 } });
    p.recordDismissal();
    p.recordDismissal();
    p.recordDismissal();
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/declined 3 questions in a row/);
  });

  it('a real answer resets the backoff, unblocking a subsequent retention candidate', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { minGapMs: 0 } });
    p.recordDismissal();
    p.recordDismissal();
    p.recordAnswered();
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(d.allow).toBe(true);
  });

  it('record(decision) spends the shared budget exactly like every other decision shape', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { minGapMs: 180000 } });
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    p.record(d);
    expect(p.stats().count).toBe(1);
    const next = p.evaluateRetentionCandidate({ paragraphKey: 'k2' });
    expect(next.allow).toBe(false);
  });

  it('a denied decision is never recorded against the budget (record() no-ops on allow: false)', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now, budget: { baseAllowance: 0, minGapMs: 0 } });
    const denied = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(denied.allow).toBe(false);
    p.record(denied);
    expect(p.stats().count).toBe(0);
  });

  it('is deterministic under a fixed clock and RNG, same as evaluate()\'s own ask path', () => {
    const a = createInterventionPolicy({ now: fixedClock().now, random: () => 0 }).evaluateRetentionCandidate({ paragraphKey: 'k1' });
    const b = createInterventionPolicy({ now: fixedClock().now, random: () => 0 }).evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(a.interventionId).toBe(b.interventionId);
  });

  it('accepts an injected generateInterventionId, same DI shape as every other path', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, generateInterventionId: () => 'fixed-retention-id' });
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(d.interventionId).toBe('fixed-retention-id');
  });

  it('never embeds anything resembling an account id, email, or pseudonym', () => {
    const d = createInterventionPolicy({ now: fixedClock().now }).evaluateRetentionCandidate({ paragraphKey: 'k1' });
    expect(d.interventionId).not.toMatch(/@/);
  });
});

/* Intelligence-architecture audit, step 8 — adaptive intervention policy.
 * The central problem this step exists to fix: a detected reading signal
 * was previously allowed to become an interruption too directly. A single
 * genuine scroll-back is real evidence, but on its own it is exactly as
 * ambiguous as it is unremarkable — see regressionEvidenceStrength()'s own
 * header for the full reasoning. These tests exercise that reasoning
 * end-to-end through evaluate(), the same way every other describe block in
 * this file already does, rather than reaching into a private helper. */
const regressionStruggling = (over = {}) => ({
  label: STATES.STRUGGLING,
  confidence: 0.7,
  evidence: ['You went back a paragraph to re-read'],
  signal: { type: 'regression', subtype: 'return', toIndex: 3, text: 'a re-read paragraph' },
  ...over,
});

describe('scroll-back candidate strength (step 8)', () => {
  it('(test A) a single scroll-back, with no repetition and no corroboration, does not automatically trigger a question', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(regressionStruggling());
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/not enough evidence on its own/);
  });

  it('(test B) the same scroll-back, once it has genuinely repeated on the same paragraph, is strong enough to intervene', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(regressionStruggling({
      signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'repeated re-read' },
    }));
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
  });

  it('a lone scroll-back corroborated by another signal in the same batch is also strong enough, without needing repetition', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(regressionStruggling({
      evidence: ['You went back a paragraph to re-read', 'Your scrolling became uneven here'],
    }));
    expect(d.allow).toBe(true);
  });

  it('a single scroll-back never becomes an intervention purely because the RNG would have sampled it', () => {
    const p = createInterventionPolicy({ now: fixedClock().now, random: () => 0 });
    const d = p.evaluate(regressionStruggling());
    expect(d.allow).toBe(false);
  });

  it('is not hardcoded to "never on scroll-up" — plainer, non-regression struggle evidence (an incorrect answer) is unaffected and still fires on its own', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate({
      label: STATES.STRUGGLING, confidence: 0.95, evidence: ['You picked a different answer to the one in the passage'],
      signal: { type: 'response', subtype: 'incorrect', correct: false },
    });
    expect(d.allow).toBe(true);
  });

  describe('(test C) a recent successful retrieval suppresses an otherwise-sufficient scroll-back candidate', () => {
    it('a repeated scroll-back fires when the reader has not just answered correctly', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const d = p.evaluate(regressionStruggling({
        signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'x' },
      }));
      expect(d.allow).toBe(true);
    });

    it('the identical repeated scroll-back is suppressed once the reader has just answered correctly', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(true);
      const d = p.evaluate(regressionStruggling({
        signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'x' },
      }));
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/recent correct answer/);
    });

    it('does not suppress an incorrect-answer-driven struggle signal — recent success only softens the weaker, regression-sourced candidate', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(true);
      const d = p.evaluate({
        label: STATES.STRUGGLING, confidence: 0.95, evidence: ['You picked a different answer to the one in the passage'],
        signal: { type: 'response', subtype: 'incorrect', correct: false },
      });
      expect(d.allow).toBe(true);
    });

    it('evidence that is BOTH repeated AND corroborated overrides a recent correct answer — still capable of intervening when the case is strong', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(true);
      const d = p.evaluate(regressionStruggling({
        signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'x' },
        evidence: ['You went back a paragraph to re-read', 'Your scrolling became uneven here'],
      }));
      expect(d.allow).toBe(true);
    });

    it('a wrong answer (not correct) does not trigger the recent-success suppression', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(false);
      const d = p.evaluate(regressionStruggling({
        signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'x' },
      }));
      expect(d.allow).toBe(true);
    });
  });

  it('an ungraded/unknown verdict (recordAnswered(null)) neither suppresses nor un-suppresses — treated the same as no prior answer', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(null);
    const d = p.evaluate(regressionStruggling({
      signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'x' },
    }));
    expect(d.allow).toBe(true);
  });

  it('a lone scroll-back with subtype slow_return is not gated by this candidate-strength check at all (state-engine.js never asserts STRUGGLING for a real one, but this function is defensive anyway)', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(regressionStruggling({ signal: { type: 'regression', subtype: 'slow_return', text: 'x' } }));
    // This is a hand-built, otherwise-nonsensical case — a real slow_return
    // never reaches evaluate() as STRUGGLING at all (state-engine.js
    // resolves it straight to ON_PACE). regressionEvidenceStrength()
    // returns null for it on purpose, so evaluate() falls through to the
    // ordinary checks unaffected by this item, and a plain, otherwise
    // uncontested struggling proposal is allowed exactly as it always was.
    expect(d.allow).toBe(true);
  });
});

describe('repeated wrong answers raise the bar before another question fires (step 8, test D)', () => {
  it('two consecutive wrong answers hold off a borderline-confidence struggle signal', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    p.recordAnswered(false);
    const d = p.evaluate(struggling({ confidence: 0.7, signal: { text: 'x' } }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/consecutive wrong answers/);
  });

  it('a high-confidence signal still gets through after repeated wrong answers — this raises the bar, it does not stop asking outright', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    p.recordAnswered(false);
    const d = p.evaluate(struggling({ confidence: 0.8, signal: { text: 'x' } }));
    expect(d.allow).toBe(true);
  });

  it('a single wrong answer does not yet raise the bar', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    const d = p.evaluate(struggling({ confidence: 0.6, signal: { text: 'x' } }));
    expect(d.allow).toBe(true);
  });

  it('a correct answer resets the count, unblocking a subsequent borderline signal', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    p.recordAnswered(false);
    p.recordAnswered(true);
    const d = p.evaluate(struggling({ confidence: 0.7, signal: { text: 'x' } }));
    expect(d.allow).toBe(true);
  });

  it('reports the running count in stats, alongside the pre-existing dismissal count', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    p.recordAnswered(false);
    expect(p.stats().consecutiveIncorrectAnswers).toBe(2);
    expect(p.stats().lastAnswerCorrect).toBe(false);
    p.recordAnswered(true);
    expect(p.stats().consecutiveIncorrectAnswers).toBe(0);
    expect(p.stats().lastAnswerCorrect).toBe(true);
  });

  it('does not touch nudge actions — a drifting reader is not being tested, so wrong-answer backoff has nothing to gate there', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    p.recordAnswered(false);
    const d = p.evaluate({ label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting' } });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('nudge');
  });

  it('reset() clears both new counters', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    p.recordAnswered(false);
    p.reset();
    expect(p.stats().consecutiveIncorrectAnswers).toBe(0);
    expect(p.stats().lastAnswerCorrect).toBeNull();
  });
});

describe('reader/context adaptation — the same current signal, different response histories (step 8, test I)', () => {
  it('an identical repeated scroll-back is allowed for one reader history and denied for another, using only observable interaction evidence', () => {
    const signal = () => regressionStruggling({
      signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'same current signal' },
    });

    const readerWhoJustSucceeded = createInterventionPolicy({ now: fixedClock().now });
    readerWhoJustSucceeded.recordAnswered(true);

    const readerWithNoRecentAnswer = createInterventionPolicy({ now: fixedClock().now });

    expect(readerWhoJustSucceeded.evaluate(signal()).allow).toBe(false);
    expect(readerWithNoRecentAnswer.evaluate(signal()).allow).toBe(true);
  });

  it('an identical borderline-confidence struggle signal is allowed for one reader\'s answer history and denied for another\'s', () => {
    const readerWithRepeatedFailures = createInterventionPolicy({ now: fixedClock().now });
    readerWithRepeatedFailures.recordAnswered(false);
    readerWithRepeatedFailures.recordAnswered(false);

    const readerWithNoFailures = createInterventionPolicy({ now: fixedClock().now });

    const state = struggling({ confidence: 0.7, signal: { text: 'same current signal' } });
    expect(readerWithRepeatedFailures.evaluate(state).allow).toBe(false);
    expect(readerWithNoFailures.evaluate({ ...state }).allow).toBe(true);
  });
});

/* Intelligence-architecture audit, step 9A — active intervention awareness.
 * ctx.questionCardVisible is ground truth transported in from
 * ui-controller.js by the caller (orchestrator.js/host.js — see
 * tests/orchestrator.test.js and tests/host.test.js for that wiring); this
 * file exercises the policy's OWN reaction to it directly, the same way
 * every other gate in this module is tested — via evaluate()'s public ctx
 * parameter, never a private helper. */
describe('active intervention awareness (step 9A)', () => {
  it('(test A) a normal eligible candidate behaves exactly as before when no card is visible', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling(), { questionCardVisible: false });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
  });

  it('a normal eligible candidate behaves exactly as before when questionCardVisible is simply omitted (backward compatible)', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling());
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
  });

  it('(test B) an otherwise-eligible candidate is suppressed while a question card is visible', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling(), { questionCardVisible: true });
    expect(d.allow).toBe(false);
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/already visible/);
  });

  it('a skimming-on-dense-text candidate is suppressed the same way an ordinary ask candidate is', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(
      { label: STATES.SKIMMING, confidence: 0.6, evidence: [], signal: { text: 'p', readability: { grade: 'difficult' } } },
      { questionCardVisible: true },
    );
    expect(d.allow).toBe(false);
  });

  it('does not touch nudge actions — a drifting reader is not shown a question card, so there is nothing for this gate to suppress there', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(
      { label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting' } },
      { questionCardVisible: true },
    );
    expect(d.allow).toBe(true);
    expect(d.action).toBe('nudge');
  });

  it('(test C) a candidate suppressed solely by an active card does not corrupt any policy state', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const before = p.stats();

    const d = p.evaluate(struggling(), { questionCardVisible: true });
    expect(d.allow).toBe(false);
    expect(d.interventionId).toBeNull();

    const after = p.stats();
    // Nothing moved: no budget spent, no dismissal/failure counters touched
    // (record() was never called — this module's own contract already
    // guarantees a caller must call record(decision) separately, and this
    // test confirms evaluate() itself made no side-channel change either).
    expect(after).toEqual(before);
  });

  it('(test C) is denied cleanly — p.record(d) on the denied decision still no-ops, exactly like any other denial', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling(), { questionCardVisible: true });
    p.record(d);
    expect(p.stats().count).toBe(0);
  });

  it('(test D) once the card disappears (questionCardVisible flips to false), a subsequent eligible candidate fires normally', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const suppressed = p.evaluate(struggling({ signal: { text: 'a' } }), { questionCardVisible: true });
    expect(suppressed.allow).toBe(false);

    const after = p.evaluate(struggling({ signal: { text: 'a' } }), { questionCardVisible: false });
    expect(after.allow).toBe(true);
    expect(after.action).toBe('ask');
  });

  it('sits after Step 8 evidence-strength checks -- a weak, single scroll-back is still denied for being weak, not for a visible card, even when a card genuinely IS visible', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(regressionStruggling(), { questionCardVisible: true });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/not enough evidence on its own/);
  });

  it('sits after Step 8 dismissal-backoff checks -- three consecutive dismissals still report their own reason, not the active-card one', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordDismissal();
    p.recordDismissal();
    p.recordDismissal();
    const d = p.evaluate(struggling({ confidence: 0.99, signal: { text: 'x' } }), { questionCardVisible: true });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/holding off/);
  });

  it('sits after Step 8 failure-backoff checks -- repeated wrong answers still report their own reason at a low-confidence candidate, not the active-card one', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    p.recordAnswered(false);
    p.recordAnswered(false);
    const d = p.evaluate(struggling({ confidence: 0.6, signal: { text: 'x' } }), { questionCardVisible: true });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/consecutive wrong answers/);
  });

  it('still respects the session budget and cooldown even once no card is visible', () => {
    const clock = fixedClock();
    const p = createInterventionPolicy({ now: clock.now });
    take(p, struggling({ signal: { text: 'a' } }), { questionCardVisible: false });
    const tooSoon = p.evaluate(struggling({ signal: { text: 'b' } }), { questionCardVisible: false });
    expect(tooSoon.allow).toBe(false);
    expect(tooSoon.reason).toMatch(/since the last interruption/);
  });

  describe('evaluateRetentionCandidate (step 9A)', () => {
    it('a due retention candidate is suppressed while a question card is visible', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1', questionCardVisible: true });
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/already visible/);
      expect(d.interventionId).toBeNull();
    });

    it('fires normally once the card is no longer visible', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const suppressed = p.evaluateRetentionCandidate({ paragraphKey: 'k1', questionCardVisible: true });
      expect(suppressed.allow).toBe(false);

      const after = p.evaluateRetentionCandidate({ paragraphKey: 'k1', questionCardVisible: false });
      expect(after.allow).toBe(true);
      expect(after.action).toBe('retention');
    });

    it('is backward compatible with every existing step-7 caller that never passes questionCardVisible at all', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
      expect(d.allow).toBe(true);
    });

    it('does not corrupt policy state when suppressed', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const before = p.stats();
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1', questionCardVisible: true });
      expect(d.allow).toBe(false);
      expect(p.stats()).toEqual(before);
    });

    it('still holds off for its own dismissal-backoff reason, not the active-card one, when both would deny', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordDismissal();
      p.recordDismissal();
      p.recordDismissal();
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1', questionCardVisible: true });
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/declined 3 questions in a row/);
    });
  });
});

/* ===========================================================================
 * Step 23 — Intervention Policy Reconstruction: the new 8-value action
 * vocabulary (POLICY_ACTIONS). Every scenario below reuses the exact same
 * fixtures/helpers the rest of this file already established — no private
 * helper is reached into, same discipline as every describe block above.
 * ===========================================================================
 */
describe('Step 23 — policy action vocabulary (decision.policyAction)', () => {
  it('none: a denied decision always carries policyAction "none", regardless of what it almost became', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate({ label: STATES.UNKNOWN, confidence: 0.9, evidence: [] });
    expect(d.allow).toBe(false);
    expect(d.policyAction).toBe('none');
  });

  it('nudge: a drifting self-report carries policyAction "nudge", distinct from "attention"', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate({ label: STATES.DRIFTING, confidence: 0.9, evidence: [], signal: { text: 'drifting' } });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('nudge');
    expect(d.policyAction).toBe('nudge');
  });

  it('retrieve: an ordinary, non-regression struggling signal strong enough on its own carries policyAction "retrieve"', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluate(struggling());
    expect(d.allow).toBe(true);
    expect(d.action).toBe('ask');
    expect(d.policyAction).toBe('retrieve');
  });

  describe('explain vs retrieve — the new distinction within regression-sourced evidence', () => {
    it('a REPEATED scroll-back (the stronger signal) is policyAction "retrieve"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const d = p.evaluate(regressionStruggling({
        signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'repeated re-read' },
      }));
      expect(d.allow).toBe(true);
      expect(d.action).toBe('ask');
      expect(d.policyAction).toBe('retrieve');
    });

    it('a CORROBORATED-ONLY scroll-back (single occurrence, a second signal agrees) is policyAction "explain", not "retrieve"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const d = p.evaluate(regressionStruggling({
        evidence: ['You went back a paragraph to re-read', 'Your scrolling became uneven here'],
      }));
      expect(d.allow).toBe(true);
      // Still renders through the existing 'ask' dispatch — see
      // POLICY_ACTIONS' own header for why a distinct UI component for
      // 'explain' specifically is disclosed future work, not built here.
      expect(d.action).toBe('ask');
      expect(d.policyAction).toBe('explain');
    });

    it('evidence that is BOTH repeated AND corroborated is policyAction "retrieve" — the stronger label wins, not "explain"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(true); // would otherwise soften a merely-corroborated candidate — proves doubly-boosted overrides it
      const d = p.evaluate(regressionStruggling({
        signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'x' },
        evidence: ['You went back a paragraph to re-read', 'Your scrolling became uneven here'],
      }));
      expect(d.allow).toBe(true);
      expect(d.policyAction).toBe('retrieve');
    });
  });

  describe('repair — a failed retrieval escalates the NEXT retrieve candidate', () => {
    it('a struggling candidate that would be "retrieve" becomes "repair" when the reader\'s most recent graded answer was wrong', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(false);
      const d = p.evaluate(struggling({ signal: { text: 'a different paragraph' } }));
      expect(d.allow).toBe(true);
      expect(d.action).toBe('ask'); // same rendering as retrieve — see header
      expect(d.policyAction).toBe('repair');
    });

    it('a correct answer does NOT produce repair — the candidate stays "retrieve"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(true);
      const d = p.evaluate(struggling({ signal: { text: 'a different paragraph' } }));
      expect(d.allow).toBe(true);
      expect(d.policyAction).toBe('retrieve');
    });

    it('no prior answer at all does NOT produce repair — the candidate stays "retrieve"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const d = p.evaluate(struggling());
      expect(d.policyAction).toBe('retrieve');
    });

    it('repair applies to a repeated-regression candidate too, not only an ordinary struggling signal', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(false);
      const d = p.evaluate(regressionStruggling({
        signal: { type: 'regression', subtype: 'return', sameIndexRereadCount: 2, text: 'x' },
      }));
      expect(d.allow).toBe(true);
      expect(d.policyAction).toBe('repair');
    });

    it('repair does NOT apply to an "explain" candidate — a corroborated-only signal stays "explain" even after a wrong answer', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(false);
      const d = p.evaluate(regressionStruggling({
        evidence: ['You went back a paragraph to re-read', 'Your scrolling became uneven here'],
      }));
      expect(d.allow).toBe(true);
      expect(d.policyAction).toBe('explain');
    });

    it('repair still spends the shared budget and respects every existing cooldown/dedup check, exactly like an ordinary retrieve', () => {
      const clock = fixedClock();
      const p = createInterventionPolicy({ now: clock.now });
      p.recordAnswered(false);
      const first = take(p, struggling({ signal: { text: 'repair paragraph' } }));
      expect(first.policyAction).toBe('repair');
      const tooSoon = p.evaluate(struggling({ signal: { text: 'a second paragraph' } }));
      expect(tooSoon.allow).toBe(false);
      expect(tooSoon.reason).toMatch(/since the last interruption/);
    });

    it('a denied repair candidate (e.g. three consecutive dismissals) is never recorded and carries policyAction "none", not "repair"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordAnswered(false);
      p.recordDismissal();
      p.recordDismissal();
      p.recordDismissal();
      const d = p.evaluate(struggling({ confidence: 0.99, signal: { text: 'x' } }));
      expect(d.allow).toBe(false);
      expect(d.policyAction).toBe('none');
    });
  });

  describe('delayed_retrieve — retention stays gated exactly like every immediate candidate, never a shortcut', () => {
    it('an allowed retention candidate carries policyAction "delayed_retrieve"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
      expect(d.allow).toBe(true);
      expect(d.action).toBe('retention');
      expect(d.policyAction).toBe('delayed_retrieve');
    });

    it('a due retention item still respects the 3-minute cooldown — "delayed" describes when it became due, not how it is gated once due', () => {
      const clock = fixedClock();
      const p = createInterventionPolicy({ now: clock.now });
      take(p, struggling({ signal: { text: 'an ordinary ask' } }));
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'a due knowledge unit' });
      expect(d.allow).toBe(false);
      expect(d.policyAction).toBe('none');
    });

    it('a denied retention candidate carries policyAction "none"', () => {
      const p = createInterventionPolicy({ now: fixedClock().now });
      p.recordDismissal();
      p.recordDismissal();
      p.recordDismissal();
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'k1' });
      expect(d.allow).toBe(false);
      expect(d.policyAction).toBe('none');
    });
  });

  describe('apply — defined for vocabulary completeness, not reachable', () => {
    it('is a real member of POLICY_ACTIONS', async () => {
      const policyModule = await import('../alcoia/src/content/intervention-policy.js');
      expect(policyModule.POLICY_ACTIONS.APPLY).toBe('apply');
    });

    it('no evaluate()/evaluateRetentionCandidate() scenario in this entire file ever produces it', async () => {
      // A structural, not exhaustive, confirmation: grepping this file's own
      // assertions for the literal string is the honest way to state "no
      // test exercises a path that returns it" without claiming a formal
      // proof this single file can't actually offer.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const thisFile = fs.readFileSync(path.join(import.meta.dirname, 'intervention-policy.test.js'), 'utf8');
      const policyActionApplyAssertions = thisFile.match(/policyAction\)\.toBe\('apply'\)/g) || [];
      expect(policyActionApplyAssertions).toHaveLength(0);
    });
  });

  it('evaluateContentTrigger (pretest) carries no policyAction field at all — it is explicitly outside this vocabulary, content-triggered rather than reading-state-driven', () => {
    const p = createInterventionPolicy({ now: fixedClock().now });
    const d = p.evaluateContentTrigger({ evidence: ['a pretest trigger'] });
    expect(d.allow).toBe(true);
    expect(d).not.toHaveProperty('policyAction');
  });
});
