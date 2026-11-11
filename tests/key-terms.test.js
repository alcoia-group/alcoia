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

import { centralSentence, markSentence, splitSentences } from '../alcoia/src/content/key-terms.js';

const LONG = 'Chloroplasts turn sunlight, water and carbon dioxide into glucose for the growing plant. Sunlight arrives mostly in the morning on the eastern side of the garden. Water climbs slowly from the roots through narrow tubes in each stem. Carbon dioxide enters through tiny pores that open underneath every leaf. Glucose later becomes starch that farmers harvest each autumn as potatoes.';

describe('centralSentence', () => {
  it('splits sentences', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });
  it('picks the sentence the rest of a long paragraph leans on', () => {
    expect(centralSentence(LONG)).toMatch(/^Chloroplasts turn sunlight/);
  });
  it('picks nothing in a short paragraph', () => {
    expect(centralSentence('Light becomes sugar. Plants grow from that sugar.')).toBeNull();
  });
  it('picks nothing when no sentence clearly stands out', () => {
    const flat = 'Cats sleep a lot during warm afternoons in summer. Dogs bark loudly at passing delivery vans outside. Birds migrate south across oceans every single autumn. Fish swim slowly near coral reefs in clear water. Horses graze quietly on open hillsides most mornings.';
    expect(centralSentence(flat)).toBeNull();
  });
});

describe('markSentence', () => {
  it('marks a sentence across inline elements, and one click removes the whole mark', () => {
    document.body.innerHTML = '<p id="s">Intro here. The <em>main</em> claim   is right here. After.</p>';
    const p = document.getElementById('s');
    expect(markSentence(p, 'The main claim is right here.')).toBe(true);
    const marks = p.querySelectorAll('mark.alcoia-key-term-sentence');
    expect(marks.length).toBeGreaterThan(1);
    expect([...marks].map((m) => m.textContent).join('')).toBe('The main claim   is right here.');
    marks[1].click();
    expect(p.querySelectorAll('mark')).toHaveLength(0);
    expect(p.textContent).toBe('Intro here. The main claim   is right here. After.');
  });
  it('returns false when the sentence is not on the page', () => {
    document.body.innerHTML = '<p id="s">Nothing like it.</p>';
    expect(markSentence(document.getElementById('s'), 'A different sentence entirely.')).toBe(false);
  });
});
