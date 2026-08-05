import { describe, it, expect } from 'vitest';
import { ResidualDistribution } from '../TL_DR/src/content/telemetry/residual-distribution.js';

describe('ResidualDistribution', () => {
  it('abstains until it has enough history', () => {
    const d = new ResidualDistribution(8);
    for (let i = 0; i < 7; i++) d.add(1 + i * 0.05);
    expect(d.ready()).toBe(false);
    expect(d.zScore(3)).toBeNull();
  });

  it('tracks mean and spread', () => {
    const d = new ResidualDistribution(4);
    for (const r of [1, 2, 3, 4, 5]) d.add(r);
    const { n, mean, sd } = d.stats();
    expect(n).toBe(5);
    expect(mean).toBeCloseTo(3, 6);
    expect(sd).toBeCloseTo(Math.sqrt(2.5), 6);
  });

  /* The behaviour this class exists for. */
  it('does not flag a consistently slow reader as unusual', () => {
    const d = new ResidualDistribution(8);
    // Someone who reliably takes ~1.8x the modelled time, with normal jitter.
    for (const r of [1.75, 1.85, 1.8, 1.78, 1.83, 1.79, 1.82, 1.81, 1.77, 1.84]) d.add(r);

    // A fixed "over 1.5x means struggling" rule would fire on every one.
    const z = d.zScore(1.80);
    expect(Math.abs(z)).toBeLessThan(1);
  });

  it('flags a paragraph that is genuinely unusual for that reader', () => {
    const d = new ResidualDistribution(8);
    for (const r of [1.75, 1.85, 1.8, 1.78, 1.83, 1.79, 1.82, 1.81, 1.77, 1.84]) d.add(r);
    expect(d.zScore(3.2)).toBeGreaterThan(1.3);
    expect(d.zScore(0.6)).toBeLessThan(-1.3);
  });

  it('rejects values that would poison the mean', () => {
    const d = new ResidualDistribution(2);
    expect(d.add(1.5)).toBe(true);
    // A tab left open for an hour, a divide-by-zero, garbage.
    expect(d.add(250)).toBe(false);
    expect(d.add(0)).toBe(false);
    expect(d.add(-3)).toBe(false);
    expect(d.add(NaN)).toBe(false);
    expect(d.add(Infinity)).toBe(false);
    expect(d.stats().n).toBe(1);
  });

  it('returns null rather than dividing by a zero spread', () => {
    const d = new ResidualDistribution(3);
    for (let i = 0; i < 5; i++) d.add(1.5);   // identical every time
    expect(d.ready()).toBe(true);
    expect(d.zScore(1.5)).toBeNull();
  });
});
