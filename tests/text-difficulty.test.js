import { describe, it, expect } from 'vitest';
import { analyzeDifficulty, syntacticLoad, fleschKincaid } from '../alcoia/src/content/signals/text-difficulty.js';

const EASY = 'The cat sat on the mat. It was warm. The sun came out. We went home. It was a good day.';

const DENSE = `Notwithstanding the foregoing considerations, the epistemological framework, which
presupposes a categorical distinction between observational and theoretical predicates, is
undermined insofar as the criteria of demarcation are themselves derived from the very
theoretical commitments whose justification was at issue, a circularity that has been
extensively documented although rarely resolved.`;

const GERMAN = `Die Wissenschaftstheorie, welche eine kategorische Unterscheidung zwischen
beobachtbaren und theoretischen Begriffen voraussetzt, wird dadurch untergraben, dass die
Abgrenzungskriterien selbst aus denjenigen theoretischen Verpflichtungen abgeleitet werden,
deren Rechtfertigung zur Debatte stand.`;

describe('syntacticLoad', () => {
  it('scores dense prose harder than simple prose', () => {
    expect(syntacticLoad(DENSE).score).toBeLessThan(syntacticLoad(EASY).score);
  });

  it('measures clause length rather than syllables', () => {
    const dense = syntacticLoad(DENSE);
    const easy  = syntacticLoad(EASY);
    expect(dense.meanClauseLength).toBeGreaterThan(easy.meanClauseLength);
    expect(dense.subordinators).toBeGreaterThan(0);
  });

  it('handles empty text without throwing', () => {
    expect(() => syntacticLoad('')).not.toThrow();
    expect(syntacticLoad('').wordCount).toBe(0);
  });
});

describe('analyzeDifficulty', () => {
  it('grades easy and dense English differently', () => {
    expect(analyzeDifficulty(EASY).grade).toBe('easy');
    expect(['difficult', 'very_difficult']).toContain(analyzeDifficulty(DENSE).grade);
  });

  it('combines FK with structure for English', () => {
    const r = analyzeDifficulty(DENSE, { isEnglish: true });
    expect(r.basis).toBe('flesch_kincaid+syntactic');
    expect(r.fleschScore).toBeDefined();
    expect(r.syntactic).toBeDefined();
  });

  /* The gap this closes: these pages previously produced no difficulty signal
   * at all, so every reading-rate expectation on them fell back to a constant. */
  it('still produces a difficulty signal on a non-English page', () => {
    const r = analyzeDifficulty(GERMAN, { isEnglish: false });
    expect(r.basis).toBe('syntactic');
    expect(r.wordCount).toBeGreaterThan(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(['easy', 'standard', 'difficult', 'very_difficult']).toContain(r.grade);
  });

  it('does not apply the syllable formula to non-English text', () => {
    const r = analyzeDifficulty(GERMAN, { isEnglish: false });
    expect(r.fleschScore).toBeUndefined();
  });

  it('keeps the shape the rest of the system consumes', () => {
    for (const r of [analyzeDifficulty(EASY), analyzeDifficulty(GERMAN, { isEnglish: false })]) {
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('grade');
      expect(r).toHaveProperty('wordCount');
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it('keeps scores inside the 0-100 scale', () => {
    const absurd = 'word '.repeat(400) + 'antidisestablishmentarianism.';
    const r = analyzeDifficulty(absurd);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('fleschKincaid is still exported for callers that want it alone', () => {
  it('returns the classic shape', () => {
    const r = fleschKincaid(EASY);
    expect(r.wordCount).toBeGreaterThan(0);
    expect(r.score).toBeGreaterThan(0);
  });
});
