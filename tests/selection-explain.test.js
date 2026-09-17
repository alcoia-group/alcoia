// @vitest-environment jsdom
/* selection-explain.js (item DC-2) — pattern classification, the session
 * dedup tracker, figure-caption lookup, and the ±2-sentence context
 * extractor. Mode names asserted here (image_context, define_word,
 * explain_more) are copied from reading alcoiaServer's
 * src/ai/summary-prompts.js directly — see that file's own SUPPORTED_MODES.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySelection, findFigureCaption, extractSurroundingContext, createSelectionExplainTracker,
} from '../alcoia/src/content/selection-explain.js';

describe('classifySelection — mathematical notation', () => {
  it('a selection with real Unicode sub/superscripts triggers, mode explain_more', () => {
    expect(classifySelection('x² + y² = z²', 'en')).toEqual({ type: 'math', mode: 'explain_more' });
  });

  it('a LaTeX-like f(x) = ... construction triggers', () => {
    expect(classifySelection('f(x) = ax + b', 'en')).toEqual({ type: 'math', mode: 'explain_more' });
  });

  it('a math operator (sum, integral, etc.) triggers regardless of surrounding length', () => {
    const longWithSum = 'consider the sum ∑ x_i taken over every index i from one up to the total count n';
    expect(classifySelection(longWithSum, 'en')?.type).toBe('math');
  });
});

describe('classifySelection — figure references and captions', () => {
  it('a bare "Figure 3" reference triggers, mode image_context', () => {
    expect(classifySelection('Figure 3', 'en')).toEqual({ type: 'figure', mode: 'image_context' });
  });

  it('"Fig. 3" and "see Figure 3 for details" both trigger', () => {
    expect(classifySelection('Fig. 3', 'en')?.type).toBe('figure');
    expect(classifySelection('see Figure 3 for details', 'en')?.type).toBe('figure');
  });

  it('a caption-like selection starting with Table/Equation/Eq. triggers', () => {
    expect(classifySelection('Table 2: Results of the trial', 'en')?.type).toBe('figure');
    expect(classifySelection('Equation 1 shows the relationship', 'en')?.type).toBe('figure');
    expect(classifySelection('Eq. 4 above', 'en')?.type).toBe('figure');
  });

  it('a long selection that only happens to mention "Figure 3" deep inside it does not trigger the figure path', () => {
    const long = 'Figure 3'.padEnd(150, ' and then a great deal more unrelated prose follows after it');
    expect(classifySelection(long, 'en')).toBeNull();
  });
});

describe('classifySelection — rare technical terms', () => {
  it('a single rare 1-3 word term triggers, mode define_word', () => {
    expect(classifySelection('mitochondria', 'en')).toEqual({ type: 'term', mode: 'define_word' });
  });

  it('an ordinary, common 2-3 word phrase does not trigger', () => {
    expect(classifySelection('in the context', 'en')).toBeNull();
    expect(classifySelection('the dog', 'en')).toBeNull();
  });

  it('four or more words never counts as a "term", even if all are rare', () => {
    expect(classifySelection('mitochondria oxidative phosphorylation cascade', 'en')).toBeNull();
  });

  it('is English-only, same as text-difficulty.js\'s lexicalRarity — a non-English "rare" word does not trigger', () => {
    expect(classifySelection('mitochondria', 'fr')).toBeNull();
    expect(classifySelection('mitochondria', undefined)).toEqual({ type: 'term', mode: 'define_word' }); // default lang is English
  });
});

describe('classifySelection — normal sentence selections do not trigger', () => {
  it('an ordinary sentence with no markers, well over 40 characters, returns null', () => {
    const sentence = 'The cat sat on the mat and looked out the window at the birds outside.';
    expect(sentence.length).toBeGreaterThan(40);
    expect(classifySelection(sentence, 'en')).toBeNull();
  });

  it('empty or whitespace-only selections return null, not a false match', () => {
    expect(classifySelection('', 'en')).toBeNull();
    expect(classifySelection('   ', 'en')).toBeNull();
    expect(classifySelection(undefined, 'en')).toBeNull();
  });
});

describe('createSelectionExplainTracker — session dedup', () => {
  it('an unexplained selection reports false, then true after marking', () => {
    const t = createSelectionExplainTracker();
    expect(t.wasExplained('Figure 3')).toBe(false);
    t.markExplained('Figure 3');
    expect(t.wasExplained('Figure 3')).toBe(true);
  });

  it('marking one selection explained does not affect a different one', () => {
    const t = createSelectionExplainTracker();
    t.markExplained('Figure 3');
    expect(t.wasExplained('Figure 4')).toBe(false);
  });

  it('paragraph-level tracking is independent of selection-level tracking', () => {
    const t = createSelectionExplainTracker();
    t.markExplained('Figure 3');
    expect(t.wasParagraphExplained('Figure 3')).toBe(false);
    t.markParagraphExplained('some paragraph key');
    expect(t.wasParagraphExplained('some paragraph key')).toBe(true);
    expect(t.wasExplained('some paragraph key')).toBe(false);
  });

  it('reset() clears both selection and paragraph tracking', () => {
    const t = createSelectionExplainTracker();
    t.markExplained('Figure 3');
    t.markParagraphExplained('key');
    t.reset();
    expect(t.wasExplained('Figure 3')).toBe(false);
    expect(t.wasParagraphExplained('key')).toBe(false);
  });

  it('a falsy paragraph key is never considered explained, and marking one is a safe no-op', () => {
    const t = createSelectionExplainTracker();
    expect(t.wasParagraphExplained('')).toBe(false);
    expect(t.wasParagraphExplained(null)).toBe(false);
    t.markParagraphExplained('');
    t.markParagraphExplained(null);
    expect(t.wasParagraphExplained('')).toBe(false);
  });
});

describe('findFigureCaption', () => {
  it('finds a real <figcaption> matching the referenced number', () => {
    document.body.innerHTML = `
      <figure><img src="a.png"><figcaption>Figure 1: An unrelated diagram.</figcaption></figure>
      <figure><img src="b.png"><figcaption>Figure 3: The actual trial results, showing a clear upward trend.</figcaption></figure>`;
    expect(findFigureCaption('Figure 3', document)).toBe('Figure 3: The actual trial results, showing a clear upward trend.');
  });

  it('falls back to a short block of text starting with the same marker when there is no <figcaption>', () => {
    document.body.innerHTML = `<p>Figure 2: Cost per unit over the study period.</p>`;
    expect(findFigureCaption('see Figure 2', document)).toBe('Figure 2: Cost per unit over the study period.');
  });

  it('returns null, never a fabricated guess, when no matching figure exists', () => {
    document.body.innerHTML = `<p>Figure 1: Something else entirely.</p>`;
    expect(findFigureCaption('Figure 9', document)).toBeNull();
  });

  it('returns null when the reference has no figure number to search for', () => {
    expect(findFigureCaption('Figure', document)).toBeNull();
  });
});

describe('extractSurroundingContext — ±2 sentences, not the whole paragraph', () => {
  const para = 'First sentence here. Second sentence with the target phrase in it. '
    + 'Third sentence follows. Fourth sentence too. Fifth and final sentence.';

  it('returns up to two sentences on each side of the one containing the selection', () => {
    const ctx = extractSurroundingContext(para, 'target phrase', 'en');
    expect(ctx).toContain('target phrase');
    expect(ctx).toContain('First sentence here.');
    expect(ctx).toContain('Third sentence follows.');
    expect(ctx).toContain('Fourth sentence too.');
    expect(ctx).not.toContain('Fifth and final sentence.'); // 3rd sentence out from the target
  });

  it('returns an empty string, not the raw selection, when the selection cannot be located', () => {
    expect(extractSurroundingContext(para, 'text that never appears anywhere', 'en')).toBe('');
  });

  it('returns an empty string for an empty paragraph', () => {
    expect(extractSurroundingContext('', 'anything', 'en')).toBe('');
  });
});
