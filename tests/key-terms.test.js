// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { pickKeyTerms, markKeyTerms, clearKeyTerms } from '../alcoia/src/content/key-terms.js';

const PARA = 'Photosynthesis converts light energy into chemical energy, stored as glucose inside the chloroplast of plant cells.';
const EXPL = 'Plants catch light energy and turn it into chemical energy. They keep that energy as glucose, a kind of sugar.';

describe('pickKeyTerms', () => {
  it('picks the words the explanation reuses from the passage, phrases first, at most three', () => {
    const terms = pickKeyTerms(PARA, EXPL);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.length).toBeLessThanOrEqual(3);
    expect(terms[0]).toBe('chemical energy');
    expect(terms).toContain('glucose');
    // never a word inside a phrase already chosen
    expect(terms).not.toContain('chemical');
  });
  it('marks nothing when the explanation shares no word with the passage', () => {
    expect(pickKeyTerms(PARA, 'Think about how a battery charges up overnight.')).toEqual([]);
  });
  it('ignores short and common words', () => {
    expect(pickKeyTerms('This is about that thing.', 'This is about that thing.')).toEqual([]);
  });
});

describe('markKeyTerms', () => {
  const setup = (html) => { document.body.innerHTML = `<p id="p">${html}</p>`; return document.getElementById('p'); };

  it('wraps the first whole-word match of each term, keeps the text unchanged, and a click removes one mark', () => {
    const p = setup('Light energy becomes <b>chemical energy</b> in the leaf. More chemical energy later.');
    expect(markKeyTerms(p, ['chemical energy', 'leaf'])).toBe(2);
    const marks = p.querySelectorAll('mark.alcoia-key-term');
    expect([...marks].map((m) => m.textContent)).toEqual(['chemical energy', 'leaf']);
    expect(p.textContent).toBe('Light energy becomes chemical energy in the leaf. More chemical energy later.');
    marks[0].click();
    expect(p.querySelectorAll('mark.alcoia-key-term')).toHaveLength(1);
    expect(p.textContent).toBe('Light energy becomes chemical energy in the leaf. More chemical energy later.');
    marks[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(p.querySelectorAll('mark')).toHaveLength(0);
  });
  it('never marks inside a link, and does not match part of a longer word', () => {
    const p = setup('<a href="#x">glucose</a> and glucosesyrup and glucose.');
    markKeyTerms(p, ['glucose']);
    const m = p.querySelector('mark');
    expect(m.parentElement.tagName).toBe('P');
    expect(p.querySelector('a mark')).toBeNull();
    clearKeyTerms(p);
    expect(p.querySelector('mark')).toBeNull();
    expect(p.textContent).toBe('glucose and glucosesyrup and glucose.');
  });
  it('adds its style once', () => {
    const p = setup('energy energy');
    markKeyTerms(p, ['energy']); markKeyTerms(p, ['energy']);
    expect(document.querySelectorAll('#alcoia-key-term-style')).toHaveLength(1);
  });
});
