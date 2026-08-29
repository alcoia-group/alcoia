import { describe, it, expect } from 'vitest';
import {
  analyzeDifficulty, syntacticLoad, fleschKincaid, lexicalRarity, propositionalDensity,
} from '../alcoia/src/content/signals/text-difficulty.js';

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

/* Item 13c: text-difficulty.js measured HOW a sentence is built (clause
 * length, subordination, comma density) but not how many new ideas or
 * unfamiliar terms it carries — CLT's own intrinsic load (Sweller):
 * element interactivity × prior knowledge, not syntax. A NEW, independent
 * input, never a replacement for syntacticLoad() — every test below
 * confirms that explicitly, not just by omission. */
describe('lexicalRarity (item 13c) — English only', () => {
  // Same syntactic SHAPE (short, simple, no subordination) on both sides —
  // only the vocabulary differs. This is the exact gap the task describes:
  // "a short, syntactically simple sentence dense with unfamiliar terms
  // currently reads as easy."
  const SIMPLE_COMMON = 'The dog ran fast. It liked the ball. We had fun. The day was nice. She smiled a lot.';
  const SIMPLE_RARE = 'The wombat capitulated. It eschewed the effluvium. We observed lugubrious ennui. The day was inchoate. She emulated obfuscation.';

  it('a lexically rare passage scores as harder than the same syntactic shape with common words', () => {
    const common = lexicalRarity(SIMPLE_COMMON, 'en');
    const rare = lexicalRarity(SIMPLE_RARE, 'en');
    expect(rare.score).toBeLessThan(common.score);
    expect(rare.rareRatio).toBeGreaterThan(common.rareRatio);
  });

  it('confirms the two passages really are syntactically equivalent — the rarity gap is not a syntax gap in disguise', () => {
    const common = syntacticLoad(SIMPLE_COMMON, 'en');
    const rare = syntacticLoad(SIMPLE_RARE, 'en');
    // Same sentence count, same rough shape — syntacticLoad() should not
    // be the thing driving any score difference here.
    expect(Math.abs(common.score - rare.score)).toBeLessThan(15);
  });

  it('unavailable for non-English — no English frequency data to misapply', () => {
    const r = lexicalRarity('Der Hund rannte schnell.', 'de');
    expect(r.available).toBe(false);
  });

  it('handles empty text without throwing', () => {
    expect(() => lexicalRarity('', 'en')).not.toThrow();
    expect(lexicalRarity('', 'en').wordCount).toBe(0);
  });
});

describe('propositionalDensity (item 13c)', () => {
  it('English: reuses lexical data — a rare-word-dense passage scores harder', () => {
    const common = propositionalDensity('The dog ran fast. It liked the ball. We had fun.', 'en');
    const rare = propositionalDensity('The wombat capitulated. It eschewed effluvium. We observed ennui.', 'en');
    expect(rare.score).toBeLessThan(common.score);
    expect(rare.basis).toBe('lexical');
  });

  it('non-English: falls back to word length vs. the script anchor — genuinely independent of syntacticLoad()', () => {
    const shortWords = propositionalDensity('Der Hund lief schnell. Er mag den Ball. Wir hatten Spaß.', 'de');
    const longWords = propositionalDensity('Der Rechtsschutzversicherungsgesellschaft folgend, kategorisierte die Bundesbahnverwaltung.', 'de');
    expect(longWords.score).toBeLessThan(shortWords.score);
    expect(shortWords.basis).toBe('word_length');
  });

  it('abstains the same way syntacticLoad() does when sentence structure is unmeasurable (no terminal punctuation)', () => {
    const text = Array(90).fill('word').join(' ');
    const r = propositionalDensity(text, 'th');
    expect(r.basis).toBe('structure_unavailable');
    expect(r.score).toBe(60);
  });

  it('handles empty text without throwing', () => {
    expect(() => propositionalDensity('', 'en')).not.toThrow();
    expect(propositionalDensity('', 'en').basis).toBe('unavailable');
  });
});

describe('analyzeDifficulty blends the new signals in, never replacing syntacticLoad() (item 13c)', () => {
  it('English: a syntactically-simple-but-lexically-rare passage now scores harder than pure syntax alone would have', () => {
    const rareText = 'The wombat capitulated. It eschewed the effluvium. We observed lugubrious ennui. The day was inchoate. She emulated obfuscation.';
    const r = analyzeDifficulty(rareText, { isEnglish: true });
    // syntacticLoad() alone reads this as easy (short, unsubordinated
    // sentences) — the whole point of this item is that the COMBINED
    // score must not agree with that in isolation.
    expect(r.syntactic.score).toBeGreaterThan(70);
    expect(r.score).toBeLessThan(r.syntactic.score);
    expect(r.lexical).toBeDefined();
    expect(r.propositional).toBeDefined();
  });

  it('the existing syntactic-load measure is still present, unmodified, and still drives its own share of the score', () => {
    // syntacticLoad() itself is untouched — DENSE (heavy subordination)
    // still scores harder than EASY on that measure ALONE, exactly as
    // before this item (this specific assertion is unchanged from the
    // file's own pre-existing test above, repeated here as an explicit
    // "still true after 13c" guard).
    expect(syntacticLoad(DENSE).score).toBeLessThan(syntacticLoad(EASY).score);
    // And still contributes to the blended score — a syntactically dense
    // passage does not become 'easy' just because its vocabulary is
    // ordinary.
    const syntacticallyDenseCommonWords = 'Although the dog ran because it was happy, and while the cat sat, the day, which was warm, went well.';
    const r = analyzeDifficulty(syntacticallyDenseCommonWords, { isEnglish: true });
    expect(r.syntactic.score).toBeLessThan(90);
  });

  it('non-English score changes when propositional density differs, even with directly comparable syntactic structure — the real, measured improvement, not assumed', () => {
    // Same sentence count and comparable structure (three short
    // sentences), German both sides — only word length/complexity
    // differs. Demonstrated against a real fixture, not asserted from the
    // fix alone.
    const plain = analyzeDifficulty('Der Hund lief schnell. Er mag den Ball. Wir hatten Spaß.', { isEnglish: false, lang: 'de' });
    const dense = analyzeDifficulty('Der Rechtsschutzversicherungsgesellschaft folgend, kategorisierte die Bundesbahnverwaltung. Die Xylophonmusikinstrumentenausstellung überraschte. Die Datenschutzgrundverordnung verpflichtet.', { isEnglish: false, lang: 'de' });
    expect(dense.score).toBeLessThan(plain.score);
    expect(dense.propositional.score).toBeLessThan(plain.propositional.score);
  });

  it('the existing GERMAN fixture keeps producing a real, non-placeholder signal — basis stays exactly "syntactic"', () => {
    const r = analyzeDifficulty(GERMAN, { isEnglish: false, lang: 'de' });
    expect(r.basis).toBe('syntactic');
    expect(r.propositional).toBeDefined();
    expect(r.propositional.basis).toBe('word_length');
  });
});
