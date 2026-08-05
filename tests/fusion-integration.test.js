/* Engine + policy together, driven the way content.js drives them.
 *
 * The defect P1 exists to fix: comprehension-monitor and the gaze classifier
 * each fired their own popups, with separate cooldowns and no shared state, so
 * one reader could be interrupted twice for the same moment of difficulty.
 * These tests pin the fix.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReadingStateEngine, STATES } from '../TL_DR/src/content/state-engine.js';
import { createInterventionPolicy } from '../TL_DR/src/content/intervention-policy.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/* Mirrors the subscriber wired into content.js. */
function buildReader(clock) {
  const engine = createReadingStateEngine({ now: clock.now });
  const policy = createInterventionPolicy({ now: clock.now });
  const interruptions = [];

  engine.subscribe((state) => {
    const decision = policy.evaluate(state);
    if (!decision.allow) return;
    policy.record(decision);
    interruptions.push({ action: decision.action, evidence: decision.evidence, label: state.label });
  });

  return { engine, policy, interruptions };
}

describe('the two pipelines can no longer both interrupt', () => {
  it('telemetry and gaze agreeing produces exactly one interruption', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    const gaze = { enabled: true, label: 'confused', quality: 0.9, lastSampleAt: clock.now() };

    // The gaze loop ticks first and sees "confused"...
    engine.update({ gaze });
    expect(interruptions).toHaveLength(0);   // it cannot act alone

    // ...then the paragraph is left and telemetry reports a slow read.
    engine.update({
      gaze,
      telemetry: {
        type: 'speed_mismatch', subtype: 'too_slow',
        text: 'the paragraph', actualWpm: 90, baselineWpm: 225,
        readability: { grade: 'standard' },
      },
    });

    expect(interruptions).toHaveLength(1);
    expect(interruptions[0].label).toBe(STATES.STRUGGLING);
    expect(interruptions[0].evidence).toContain('Eye tracking agrees');
  });

  it('a burst of signals across both pipelines still yields one interruption', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);
    const gaze = { enabled: true, label: 'confused', quality: 0.9, lastSampleAt: clock.now() };

    engine.update({ telemetry: { type: 'backtrack', backtrackPx: 200 }, gaze });
    clock.advance(1000);
    engine.update({ gaze });
    clock.advance(1000);
    engine.update({
      telemetry: { type: 'speed_mismatch', subtype: 'too_slow', text: 'another paragraph', actualWpm: 80, baselineWpm: 220 },
      gaze,
    });

    expect(interruptions).toHaveLength(1);
  });

  it('holds the three-minute gap across pipelines, not per-pipeline', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({ telemetry: { type: 'backtrack', backtrackPx: 200 } });
    expect(interruptions).toHaveLength(1);

    // A different pipeline, a different paragraph, 60s later — still too soon.
    clock.advance(60_000);
    engine.update({});
    engine.update({
      telemetry: { type: 'speed_mismatch', subtype: 'too_slow', text: 'fresh paragraph', actualWpm: 80, baselineWpm: 220 },
    });
    expect(interruptions).toHaveLength(1);

    clock.advance(130_000);
    engine.update({});
    engine.update({
      telemetry: { type: 'speed_mismatch', subtype: 'too_slow', text: 'fresh paragraph', actualWpm: 80, baselineWpm: 220 },
    });
    expect(interruptions).toHaveLength(2);
  });
});

describe('camera-off behaviour', () => {
  it('detects and interrupts on telemetry alone', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    engine.update({
      gaze: { enabled: false },
      telemetry: { type: 'speed_mismatch', subtype: 'too_slow', text: 'p', actualWpm: 90, baselineWpm: 240 },
    });

    expect(interruptions).toHaveLength(1);
    expect(interruptions[0].evidence[0]).toMatch(/slower than your usual pace/);
    expect(interruptions[0].evidence).not.toContain('Eye tracking agrees');
  });

  it('never interrupts from gaze alone, however confident it looks', () => {
    const clock = fixedClock();
    const { engine, interruptions } = buildReader(clock);

    for (const label of ['confused', 'overloaded', 'zoning_out', 'skimming', 'focused']) {
      clock.advance(300_000);
      engine.update({ gaze: { enabled: true, label, quality: 1.0, lastSampleAt: clock.now() } });
    }

    expect(interruptions).toHaveLength(0);
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

    for (const telemetry of cases) {
      clock.advance(300_000);
      engine.update({});
      engine.update({ telemetry });
    }

    expect(interruptions).toHaveLength(3);
    for (const i of interruptions) {
      expect(i.evidence.length).toBeGreaterThan(0);
      expect(i.evidence[0]).toMatch(/^[A-Z]/);       // reads as a sentence
      expect(i.evidence[0]).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
