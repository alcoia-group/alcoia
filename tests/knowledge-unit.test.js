/* knowledge-unit.js — V1 content-hashed knowledge-unit identity
 * (intelligence-architecture audit, step 3). See that file's own header for
 * the full normalization rules and the reasoning behind FNV-1a over
 * crypto.subtle. */
import { describe, it, expect } from 'vitest';
import { computeKnowledgeUnitId, normalizeParagraphText } from '../alcoia/src/content/signals/knowledge-unit.js';

describe('computeKnowledgeUnitId', () => {
  it('identical text produces an identical identity', () => {
    const text = 'The relationship between the two variables is real but weak.';
    expect(computeKnowledgeUnitId(text)).toBe(computeKnowledgeUnitId(text));
  });

  it('is deterministic across repeated calls, not just within one test', () => {
    const text = 'A stable identity should not depend on when or how often it is computed.';
    const results = new Set(Array.from({ length: 20 }, () => computeKnowledgeUnitId(text)));
    expect(results.size).toBe(1);
  });

  it('surrounding whitespace does not change the identity', () => {
    const text = 'Surrounded by whitespace.';
    expect(computeKnowledgeUnitId(`   ${text}   `)).toBe(computeKnowledgeUnitId(text));
    expect(computeKnowledgeUnitId(`\n\n${text}\t\t`)).toBe(computeKnowledgeUnitId(text));
  });

  it('line breaks and repeated internal whitespace normalize to the same identity as single spaces', () => {
    const a = 'This sentence has   several     spaces in it.';
    const b = 'This sentence has\nseveral\n\nspaces in it.';
    const c = 'This sentence has\tseveral\t\tspaces in it.';
    const canonical = 'This sentence has several spaces in it.';
    expect(computeKnowledgeUnitId(a)).toBe(computeKnowledgeUnitId(canonical));
    expect(computeKnowledgeUnitId(b)).toBe(computeKnowledgeUnitId(canonical));
    expect(computeKnowledgeUnitId(c)).toBe(computeKnowledgeUnitId(canonical));
  });

  it('a meaningful text change produces a different identity', () => {
    const original = 'The mitochondria is the powerhouse of the cell.';
    const changedWord = 'The mitochondria is the powerhouse of the organism.';
    const changedPunctuation = 'The mitochondria is the powerhouse of the cell!';
    expect(computeKnowledgeUnitId(changedWord)).not.toBe(computeKnowledgeUnitId(original));
    expect(computeKnowledgeUnitId(changedPunctuation)).not.toBe(computeKnowledgeUnitId(original));
  });

  it('case is preserved, not normalized — the investigation found no reason to fold it', () => {
    const lower = 'paris is the capital of france.';
    const upper = 'Paris is the capital of France.';
    expect(computeKnowledgeUnitId(lower)).not.toBe(computeKnowledgeUnitId(upper));
  });

  it('is a pure function of its own text — it does not take or encode a document scope itself', () => {
    // Document scope is applied by whatever wraps this value (assignment_id
    // server-side, documentKey client-side), not by this function — see its
    // own header. Two calls with the same text but no document context
    // return the identical id; callers are responsible for pairing it with
    // a document key wherever cross-document ambiguity would matter.
    const text = 'A sentence that could appear verbatim in two unrelated documents.';
    expect(computeKnowledgeUnitId(text)).toBe(computeKnowledgeUnitId(text));
  });

  it('duplicate identical paragraphs get the SAME knowledge-unit identity — this hashes content, not occurrence', () => {
    const repeated = 'This exact sentence appears twice in the same document.';
    const firstOccurrence = computeKnowledgeUnitId(repeated);
    const secondOccurrence = computeKnowledgeUnitId(repeated);
    expect(firstOccurrence).toBe(secondOccurrence);
    // paragraphIndex (unchanged, generated elsewhere by paragraph-tracker.js)
    // is what still distinguishes the two physical occurrences — not this
    // function's job, and not something it can or should do.
  });

  it('empty, whitespace-only, or missing text returns null rather than a fabricated identity', () => {
    expect(computeKnowledgeUnitId('')).toBeNull();
    expect(computeKnowledgeUnitId('   ')).toBeNull();
    expect(computeKnowledgeUnitId('\n\t  \n')).toBeNull();
    expect(computeKnowledgeUnitId(undefined)).toBeNull();
    expect(computeKnowledgeUnitId(null)).toBeNull();
  });

  it('a non-string input is coerced, not thrown on', () => {
    expect(() => computeKnowledgeUnitId(42)).not.toThrow();
    expect(computeKnowledgeUnitId(42)).toBe(computeKnowledgeUnitId('42'));
  });

  it('always returns the documented k<hash><length> shape when given real text', () => {
    const id = computeKnowledgeUnitId('A real paragraph with real content in it.');
    expect(id).toMatch(/^k[0-9a-f]+$/);
  });

  it('two different real paragraphs are, in practice, never equal (collision sanity check over a real vocabulary)', () => {
    const paragraphs = [
      'The mitochondria is the powerhouse of the cell.',
      'Photosynthesis converts light energy into chemical energy.',
      'The French Revolution began in 1789.',
      'Supply and demand determine market price in a competitive market.',
      'Newton\'s second law relates force, mass, and acceleration.',
      'The water cycle includes evaporation, condensation, and precipitation.',
      'DNA carries the genetic instructions for growth and reproduction.',
      'The Renaissance was a period of cultural rebirth in Europe.',
    ];
    const ids = paragraphs.map(computeKnowledgeUnitId);
    expect(new Set(ids).size).toBe(paragraphs.length);
  });
});

describe('normalizeParagraphText', () => {
  it('collapses whitespace and trims — exported so callers/tests can reason about the exact normalized form', () => {
    expect(normalizeParagraphText('  a   b\n\nc\t d  ')).toBe('a b c d');
  });

  it('never changes word content, only inter-word whitespace', () => {
    const text = "Don't change punctuation, CAPS, or word-content — only whitespace!";
    expect(normalizeParagraphText(text)).toBe(text);
  });
});
