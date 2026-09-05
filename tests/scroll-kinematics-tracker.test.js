/* scroll-kinematics-tracker.js (item DC-1a) — every field checked against a
 * hand-computed synthetic scroll sequence, not just "returns something". See
 * that file's own header for why this lives outside src/content/signals/
 * (not a state-engine detector) and why jitter_score is a fresh computation,
 * not scroll-dynamics.js's own "jerk" reused. */
import { describe, it, expect } from 'vitest';
import { createScrollKinematicsTracker } from '../alcoia/src/content/scroll-kinematics-tracker.js';

describe('summary() — not enough history returns null, not a garbage object', () => {
  it('zero scroll events', () => {
    const t = createScrollKinematicsTracker();
    expect(t.summary()).toBeNull();
  });

  it('one scroll event (no velocity can exist yet)', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    expect(t.summary()).toBeNull();
  });

  it('two scroll events (exactly one velocity — still not enough for a MAD/variance)', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(100, 100);
    expect(t.summary()).toBeNull();
  });

  it('three scroll events (two velocities) is the minimum that returns real stats', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(100, 100);
    t.update(200, 200);
    expect(t.summary()).not.toBeNull();
  });
});

describe('summary() — constant velocity (the clean baseline case)', () => {
  // y = 0,10,20,30,40,50 at t = 0,100,...,500 -> five identical velocities
  // of 0.1 px/ms. Every "how much did it change" statistic should read as
  // exactly zero, and every "how smooth was it" statistic should read as
  // maximally smooth — a real assertion, not just "is a number".
  function constantVelocityTracker() {
    const t = createScrollKinematicsTracker();
    for (let i = 0; i <= 5; i++) t.update(i * 10, i * 100);
    return t;
  }

  it('scroll_events counts every update() call, not every velocity', () => {
    expect(constantVelocityTracker().summary().scroll_events).toBe(6);
  });

  it('velocity_p50/p95 both equal the constant velocity, variance is zero', () => {
    const s = constantVelocityTracker().summary();
    expect(s.velocity_p50).toBeCloseTo(0.1, 10);
    expect(s.velocity_p95).toBeCloseTo(0.1, 10);
    expect(s.velocity_variance).toBeCloseTo(0, 10);
  });

  it('jitter_score is zero — no successive velocity ever changed', () => {
    expect(constantVelocityTracker().summary().jitter_score).toBeCloseTo(0, 10);
  });

  it('no acceleration events and no direction changes at a constant speed', () => {
    const s = constantVelocityTracker().summary();
    expect(s.acceleration_events).toBe(0);
    expect(s.direction_changes).toBe(0);
  });

  it('smooth_scroll_ratio is 1 — every pair changed by 0% of the previous velocity', () => {
    expect(constantVelocityTracker().summary().smooth_scroll_ratio).toBeCloseTo(1, 10);
  });

  it('no micro-corrections — every delta is forward', () => {
    expect(constantVelocityTracker().summary().micro_correction_count).toBe(0);
  });
});

describe('summary() — micro_correction_count / micro_correction_rate', () => {
  // deltas: +100, -10, +100, +90 (dt=100 throughout). Only the -10 is both
  // backward and under the 50px floor.
  it('counts only backward deltas under 50px, and rate is count/scroll_events', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(100, 100);
    t.update(90, 200);
    t.update(190, 300);
    t.update(280, 400);
    const s = t.summary();
    expect(s.scroll_events).toBe(5);
    expect(s.micro_correction_count).toBe(1);
    expect(s.micro_correction_rate).toBeCloseTo(1 / 5, 10);
  });

  it('a backward delta of exactly 50px does not count (strictly under 50, not at it)', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(100, 100);
    t.update(50, 200); // delta = -50, backward, but not < 50
    t.update(150, 300);
    expect(t.summary().micro_correction_count).toBe(0);
  });
});

describe('summary() — acceleration_events (> 2x the session median absolute velocity)', () => {
  // velocities: 1,1,1,1,10 (dt=10 throughout, deltas 10,10,10,10,100).
  // median |v| = 1, so the threshold is 2. Only the 1->10 jump (diff 9)
  // clears it.
  it('flags only the genuine spike, not the constant run before it', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(10, 10);
    t.update(20, 20);
    t.update(30, 30);
    t.update(40, 40);
    t.update(140, 50);
    expect(t.summary().acceleration_events).toBe(1);
  });
});

describe('summary() — direction_changes (sign reversals between successive velocities)', () => {
  // y oscillates 0,10,0,10,0 (dt=10 throughout) -> velocities 1,-1,1,-1,
  // every successive pair flips sign.
  it('counts every sign flip between consecutive velocities', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(10, 10);
    t.update(0, 20);
    t.update(10, 30);
    t.update(0, 40);
    expect(t.summary().direction_changes).toBe(3);
  });
});

describe('summary() — smooth_scroll_ratio (< 10% velocity change from the previous event)', () => {
  // velocities: 1, 1.05 (+5%, smooth), 1.1025 (+5% again, smooth),
  // 5 (a huge jump, not smooth). 2 of 3 pairs are smooth.
  it('is the fraction of consecutive pairs under the 10% change threshold', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(100, 100);   // v=1
    t.update(205, 200);   // v=1.05
    t.update(315.25, 300); // v=1.1025
    t.update(815.25, 400); // v=5
    expect(t.summary().smooth_scroll_ratio).toBeCloseTo(2 / 3, 10);
  });
});

describe('update() — the same guards scroll-dynamics.js already uses', () => {
  it('a duplicate or out-of-order timestamp (dt <= 0) is skipped, not divided-by-zero into Infinity/NaN', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(100, 100);
    t.update(150, 100); // same timestamp again — must not produce Infinity
    t.update(200, 200);
    const s = t.summary();
    expect(Number.isFinite(s.velocity_p50)).toBe(true);
    expect(Number.isFinite(s.velocity_variance)).toBe(true);
    expect(Number.isFinite(s.jitter_score)).toBe(true);
  });
});

describe('reset()', () => {
  it('clears accumulated history back to "not enough data"', () => {
    const t = createScrollKinematicsTracker();
    t.update(0, 0);
    t.update(100, 100);
    t.update(200, 200);
    expect(t.summary()).not.toBeNull();
    t.reset();
    expect(t.summary()).toBeNull();
  });
});
