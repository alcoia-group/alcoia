/* Engine + policy together, driven the way content.js drives them.
 *
 * The defect P1 exists to fix: comprehension-monitor and a webcam gaze
 * classifier used to each fire their own popups, with separate cooldowns and
 * no shared state, so one reader could be interrupted twice for the same
 * moment of difficulty. These tests pinned the fix by driving both pipelines
 * at once; the gaze classifier is gone now (see CLAUDE.md's migration note),
 * so what is left to pin is that the single remaining pipeline still
 * produces exactly one interruption per moment of difficulty.
 */
import { describe, it, expect } from 'vitest';
import { createReadingStateEngine } from '../alcoia/src/content/state-engine.js';
import { createInterventionPolicy } from '../alcoia/src/content/intervention-policy.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/* Mirrors the subscriber wired into content.js. */
function buildReader(clock) {
  const engine = createReadingStateEngine({ now: clock.now });
  const policy = createInterventionPolicy({ now: clock.now, random: () => 1 });
  const interruptions = [];

  engine.subscribe((state) => {
    const decision = policy.evaluate(state);
    if (!decision.allow) return;
    policy.record(decision);
    interruptions.push({ action: decision.action, evidence: decision.evidence, label: state.label });
  });

  return { engine, policy, interruptions };
}

describe('one moment of difficulty produces exactly one interruption', () => {
  it('a burst of related signals still yields one interruption', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    clock.advance(1000);
    engine.update({
      reading: { type: 'speed_mismatch', subtype: 'too_slow', text: 'another paragraph', actualWpm: 80, baselineWpm: 220 },
    });

    expect(interruptions).toHaveLength(1);
  });

  it('holds the three-minute gap across separate reading signals', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    expect(interruptions).toHaveLength(1);

    // A different signal, a different paragraph, 60s later — still too soon.
    clock.advance(60_000);
    engine.update({});
    engine.update({
      reading: { type: 'speed_mismatch', subtype: 'too_slow', text: 'fresh paragraph', actualWpm: 80, baselineWpm: 220 },
    });
    expect(interruptions).toHaveLength(1);

    clock.advance(130_000);
    engine.update({});
    engine.update({
      reading: { type: 'speed_mismatch', subtype: 'too_slow', text: 'fresh paragraph', actualWpm: 80, baselineWpm: 220 },
    });
    expect(interruptions).toHaveLength(2);
  });
});

describe('detection is signals-only', () => {
  it('detects and interrupts on reading signals alone', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({
      reading: { type: 'speed_mismatch', subtype: 'too_slow', text: 'p', actualWpm: 90, baselineWpm: 240 },
    });

    expect(interruptions).toHaveLength(1);
    expect(interruptions[0].evidence[0]).toMatch(/slower than your usual pace/);
  });
});

/* Intelligence-architecture audit, step 8 — the same "detection ≠
 * intervention" fix exercised through the REAL engine -> policy pipeline
 * (not a hand-built decision object), the same way every other describe
 * block in this file already drives both pieces together. See
 * tests/intervention-policy.test.js's own "scroll-back candidate strength"
 * block for the exhaustive unit-level coverage; this is the end-to-end
 * confirmation that the same fix holds once a real regression signal has
 * gone through state-engine.js's own STRUGGLING/confidence computation
 * first, not just a fixture built to look like its output. */
describe('a single scroll-back does not automatically become an interruption (step 8)', () => {
  it('one genuine re-read, with no repetition, produces no interruption at all', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({ reading: { type: 'regression', subtype: 'return', distance: 2, latencyMs: 5000 } });

    expect(interruptions).toHaveLength(0);
  });

  it('the SAME paragraph re-read a second time (sameIndexRereadCount reaching 2) is strong enough to interrupt', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({ reading: { type: 'regression', subtype: 'return', distance: 2, latencyMs: 5000, sameIndexRereadCount: 2 } });

    expect(interruptions).toHaveLength(1);
    expect(interruptions[0].action).toBe('ask');
  });

  it('a plainer struggle signal (an incorrect answer) is unaffected and still interrupts on its own — not a blanket "never on scroll movement" rule', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({ reading: { type: 'response', subtype: 'incorrect', correct: false } });

    expect(interruptions).toHaveLength(1);
  });
});

describe('every interruption can say what it noticed', () => {
  it('carries non-empty, human-readable evidence', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    const cases = [
      { type: 'backtrack', backtrackPx: 240 },
      { type: 'speed_mismatch', subtype: 'too_slow', text: 'b', actualWpm: 90, baselineWpm: 225 },
      { type: 'speed_mismatch', subtype: 'too_fast', text: 'c', readability: { grade: 'difficult' } },
    ];

    for (const reading of cases) {
      clock.advance(300_000);
      engine.update({});
      engine.update({ reading });
    }

    expect(interruptions).toHaveLength(3);
    for (const i of interruptions) {
      expect(i.evidence.length).toBeGreaterThan(0);
      expect(i.evidence[0]).toMatch(/^[A-Z]/);       // reads as a sentence
      expect(i.evidence[0]).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
