import { describe, it, expect } from 'vitest';
import { pickLoadBearingTerms, wrapTerms, renderHighlightedExplanation } from '../alcoia/src/content/keyword-highlight.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

describe('pickLoadBearingTerms', () => {
  it('picks 2-4 substantive words, longest first', () => {
    const terms = pickLoadBearingTerms(
      'The relationship between eye position and cognitive attention is real but weak.');
    expect(terms.length).toBeGreaterThanOrEqual(2);
    expect(terms.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < terms.length; i++) expect(terms[i].length).toBeLessThanOrEqual(terms[i - 1].length);
  });

  it('never returns more than 4', () => {
    const terms = pickLoadBearingTerms(
      'Aardvark biology chemistry dinosaur elephant flamingo giraffe hedgehog important journey ' +
      'kangaroo lighthouse mountain notebook orchestra painting quantum research symphony telescope');
    expect(terms.length).toBeLessThanOrEqual(4);
  });

  it('returns nothing rather than one term — a single highlight is not the two-to-four range', () => {
    // Only one word clears the length/stopword filter.
    expect(pickLoadBearingTerms('It was the cat that sat on it.')).toEqual([]);
  });

  it('returns nothing for empty or missing text', () => {
    expect(pickLoadBearingTerms('')).toEqual([]);
    expect(pickLoadBearingTerms(null)).toEqual([]);
    expect(pickLoadBearingTerms(undefined)).toEqual([]);
  });

  it('excludes common short function words even when text is otherwise long', () => {
    const terms = pickLoadBearingTerms(
      'This is because that would have been about which they were with their there');
    expect(terms).toEqual([]);
  });

  it('degrades to nothing for a script the Latin-word regex cannot tokenise, rather than guessing', () => {
    // Chinese text — no Latin-script "words" for the regex to find at all.
    expect(pickLoadBearingTerms('眼睛所指向的位置与心智所进行的活动之间的关系是真实存在的，但相当微弱。')).toEqual([]);
  });

  it('never duplicates a term that appears more than once', () => {
    const terms = pickLoadBearingTerms('measurement measurement measurement apparatus apparatus laboratory');
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe('wrapTerms', () => {
  it('wraps a whole-word match in a literal span', () => {
    const html = wrapTerms(esc('The measurement apparatus was cheap.'), ['measurement']);
    expect(html).toBe('The <span class="sra-term">measurement</span> apparatus was cheap.');
  });

  it('is case-insensitive but preserves the original casing in the output', () => {
    const html = wrapTerms(esc('Apparatus matters.'), ['apparatus']);
    expect(html).toContain('<span class="sra-term">Apparatus</span>');
  });

  it('only wraps a whole word, not a substring inside a longer word', () => {
    const html = wrapTerms(esc('The measurements were noisy.'), ['measurement']);
    expect(html).not.toContain('<span');
  });

  it('never introduces markup from the input text itself — only its own literal span tags', () => {
    // Simulates a model response that tried to inject markup; esc() already
    // neutralised it before this function ever sees it.
    const malicious = '<img src=x onerror=alert(1)> the measurement was off';
    const html = wrapTerms(esc(malicious), ['measurement']);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<span class="sra-term">measurement</span>');
  });

  it('wraps only the first occurrence of a repeated term', () => {
    const html = wrapTerms(esc('measurement measurement measurement'), ['measurement']);
    expect((html.match(/<span/g) || []).length).toBe(1);
  });
});

describe('renderHighlightedExplanation', () => {
  it('returns escaped plain text unchanged when fewer than 2 terms qualify', () => {
    const text = 'It was the cat that sat on it.';
    expect(renderHighlightedExplanation(text, esc)).toBe(esc(text));
  });

  it('wraps qualifying terms in the escaped output', () => {
    const text = 'The measurement apparatus in the laboratory was noisy and imprecise.';
    const html = renderHighlightedExplanation(text, esc);
    expect(html).toContain('<span class="sra-term">');
    expect(html).not.toContain('<script');
  });

  it('never introduces unescaped HTML from the source text', () => {
    const text = '<b>bold</b> measurement apparatus laboratory noisy';
    const html = renderHighlightedExplanation(text, esc);
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;');
  });
});
