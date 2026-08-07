import { describe, it, expect } from 'vitest';
import { createSessionRecall, MIN_DWELL_MS } from '../alcoia/src/content/telemetry/session-recall.js';

const para = (n, words = 60) => `paragraph-${n} ` + Array.from({ length: words }, (_, i) => `w${i}`).join(' ');

/* Deterministic "random" so weighted selection can be asserted. */
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('what counts as read', () => {
  it('ignores paragraphs that were passed over', () => {
    const r = createSessionRecall();
    r.recordRead(para(1), 1000);
    expect(r.candidates()).toHaveLength(0);
    expect(r.select(5)).toHaveLength(0);
  });

  it('ignores short blocks regardless of dwell', () => {
    const r = createSessionRecall();
    r.recordRead('too short to ask about', 60000);
    expect(r.candidates()).toHaveLength(0);
  });

  it('accumulates dwell across return visits', () => {
    const r = createSessionRecall();
    r.recordRead(para(1), MIN_DWELL_MS / 2);
    expect(r.candidates()).toHaveLength(0);
    r.recordRead(para(1), MIN_DWELL_MS / 2);
    expect(r.candidates()).toHaveLength(1);
  });
});

describe('selection', () => {
  it('returns nothing when nothing was read', () => {
    expect(createSessionRecall().select(5)).toHaveLength(0);
  });

  it('never returns more than asked for, or more than exist', () => {
    const r = createSessionRecall({ random: seq([0.5]) });
    for (let i = 0; i < 3; i++) r.recordRead(para(i), 10000);
    expect(r.select(5)).toHaveLength(3);
    expect(r.select(2)).toHaveLength(2);
  });

  it('does not repeat a paragraph within one selection', () => {
    const r = createSessionRecall({ random: seq([0, 0, 0, 0]) });
    for (let i = 0; i < 4; i++) r.recordRead(para(i), 10000);
    const picked = r.select(4).map((e) => e.text);
    expect(new Set(picked).size).toBe(4);
  });

  /* Weighting, not ranking. Struggled paragraphs should dominate over many
   * draws without ever being the only thing that can be asked. */
  it('favours struggled paragraphs without excluding the rest', () => {
    let struggledPicks = 0;
    const trials = 300;

    for (let t = 0; t < trials; t++) {
      const r = createSessionRecall();
      r.recordRead(para('hard'), 10000);
      r.recordStruggle(para('hard'));
      r.recordStruggle(para('hard'));
      for (let i = 0; i < 4; i++) r.recordRead(para(i), 10000);

      if (r.select(1)[0].text.startsWith('paragraph-hard')) struggledPicks++;
    }

    const rate = struggledPicks / trials;
    // Weight 6 against four paragraphs of weight 1 → ~0.6 expected.
    expect(rate).toBeGreaterThan(0.35);
    expect(rate).toBeLessThan(0.85);
  });

  it('deprioritises a paragraph the reader already answered correctly', () => {
    let picks = 0;
    const trials = 300;

    for (let t = 0; t < trials; t++) {
      const r = createSessionRecall();
      r.recordRead(para('done'), 10000);
      r.recordStruggle(para('done'));
      r.recordAnswered(para('done'), true);
      for (let i = 0; i < 3; i++) r.recordRead(para(i), 10000);
      if (r.select(1)[0].text.startsWith('paragraph-done')) picks++;
    }
    // Weight 3.5 * 0.25 against three of weight 1 → well under a quarter.
    expect(picks / trials).toBeLessThan(0.35);
  });

  it('does not deprioritise on a wrong answer', () => {
    const r = createSessionRecall();
    r.recordRead(para(1), 10000);
    r.recordAnswered(para(1), false);
    expect(r.candidates()[0].answeredCorrectly).toBe(false);
  });

  it('ignores struggle reported for a paragraph it never saw', () => {
    const r = createSessionRecall();
    expect(() => r.recordStruggle(para('unknown'))).not.toThrow();
    expect(r.candidates()).toHaveLength(0);
  });
});

describe('stats', () => {
  it('separates seen from actually read', () => {
    const r = createSessionRecall();
    r.recordRead(para(1), 500);      // seen, not read
    r.recordRead(para(2), 20000);    // read
    r.recordStruggle(para(2));

    const s = r.stats();
    expect(s.paragraphsSeen).toBe(2);
    expect(s.paragraphsRead).toBe(1);
    expect(s.struggled).toBe(1);
  });
});
