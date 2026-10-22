// @vitest-environment jsdom
/* Detection timing: the continuous expected-time model, very hard paragraphs, screen-at-a-time readers, and
 * the word lists for five more languages. Time is driven with fake timers; nothing here touches a network. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createComprehensionMonitor } from '../alcoia/src/content/comprehension-monitor.js';
import { analyzeDifficulty, lexicalRarity, loadLexicon, LEXICON_LANGUAGES } from '../alcoia/src/content/signals/text-difficulty.js';
import { createReadingTimeModel, PRIORS, BOUNDS, MULT_RANGE, R0, C0 } from '../alcoia/src/content/signals/reading-time-model.js';
import { createScreenTiming, SCREEN } from '../alcoia/src/content/signals/screen-timing.js';

const EASY = (n) => 'The cat sat on the mat and looked at the dog. '.repeat(Math.ceil(n / 10)).trim();
const VERY_HARD = 'Notwithstanding the epistemological ramifications of poststructuralist hermeneutics, the phenomenological reduction necessitates an intersubjective reconstitution of transcendental subjectivity, whereby ontological commitments are simultaneously bracketed and reinstated insofar as consciousness constitutes itself intentionally. '.repeat(3);
const el = (text) => ({ innerText: text, textContent: text });

function fakeChrome(seed = {}) {
  const store = { ...seed };
  return {
    storage: { local: {
      get(keys, cb) { const r = {}; for (const [k, d] of Object.entries(keys || {})) r[k] = k in store ? store[k] : d; cb(r); },
      set(o, cb) { Object.assign(store, o); if (cb) cb(); },
    } },
    _store: store,
  };
}
function scrollTo(y) { Object.defineProperty(window, 'scrollY', { value: y, configurable: true }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  document.documentElement.lang = 'en';
  document.body.innerHTML = '';
  scrollTo(0);
  globalThis.chrome = fakeChrome();
});
afterEach(() => { vi.useRealTimers(); delete globalThis.chrome; });

describe('reading-time model', () => {
  it('starts at the prior: ordinary text is the reader\'s ordinary pace, harder text takes longer', () => {
    const m = createReadingTimeModel();
    expect(m.multiplier({ rareShare: R0, clauseLength: C0 })).toBeCloseTo(PRIORS[0], 5);
    expect(m.multiplier({ rareShare: 0.3, clauseLength: C0 })).toBeGreaterThan(1.2);
    expect(m.multiplier({ rareShare: R0, clauseLength: 16 })).toBeGreaterThan(1.2);
  });

  it('is continuous: a small change in the text never makes a large change in the expectation', () => {
    const m = createReadingTimeModel();
    let prev = m.multiplier({ rareShare: 0, clauseLength: 7 });
    let biggest = 0;
    for (let r = 0.001; r <= 0.6; r += 0.001) {
      const cur = m.multiplier({ rareShare: r, clauseLength: 7 });
      biggest = Math.max(biggest, Math.abs(cur - prev));
      prev = cur;
    }
    expect(biggest).toBeLessThan(0.002);
  });

  it('missing figures count as ordinary text, never as a guess', () => {
    const m = createReadingTimeModel();
    expect(m.multiplier({ rareShare: null, clauseLength: null })).toBeCloseTo(1, 5);
    expect(m.multiplier({})).toBeCloseTo(1, 5);
  });

  it('moves towards a reader who is much slower on dense text, but stays inside its bounds', () => {
    const m = createReadingTimeModel();
    const dense = { rareShare: 0.4, clauseLength: 14 };
    const before = m.multiplier(dense);
    for (let i = 0; i < 80; i++) {
      m.update({ rareShare: 0.05, clauseLength: 6 }, 0.95);
      m.update(dense, 3.0);
    }
    const after = m.multiplier(dense);
    expect(after).toBeGreaterThan(before);
    const [b0, b1, b2] = m.coefficients();
    expect(b0).toBeGreaterThanOrEqual(BOUNDS.b0[0]);
    expect(b0).toBeLessThanOrEqual(BOUNDS.b0[1]);
    expect(b1).toBeLessThanOrEqual(BOUNDS.b1[1]);
    expect(b2).toBeLessThanOrEqual(BOUNDS.b2[1]);
    expect(after).toBeLessThanOrEqual(MULT_RANGE[1]);
  });

  it('a run of stalls (ten times too slow) cannot teach it that ordinary text is slow', () => {
    const m = createReadingTimeModel();
    for (let i = 0; i < 200; i++) m.update({ rareShare: R0, clauseLength: C0 }, 10);
    expect(m.multiplier({ rareShare: R0, clauseLength: C0 })).toBeLessThanOrEqual(MULT_RANGE[1]);
    expect(m.coefficients()[0]).toBeLessThanOrEqual(BOUNDS.b0[1]);
  });

  it('ignores nonsense and survives a save and restore', () => {
    const m = createReadingTimeModel();
    expect(m.update({}, NaN)).toBe(false);
    expect(m.update({}, -1)).toBe(false);
    for (let i = 0; i < 30; i++) m.update({ rareShare: 0.3, clauseLength: 12 }, 1.8);
    const copy = createReadingTimeModel();
    expect(copy.hydrate(JSON.parse(JSON.stringify(m.serialize())))).toBe(true);
    expect(copy.multiplier({ rareShare: 0.3, clauseLength: 12 })).toBeCloseTo(m.multiplier({ rareShare: 0.3, clauseLength: 12 }), 6);
    expect(createReadingTimeModel().hydrate({ A: 'x' })).toBe(false);
  });

  it('is kept per reader in storage, so the next session starts from what was learned', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    for (let i = 0; i < 7; i++) { m.enterParagraph(el(text)); vi.advanceTimersByTime(25000); m.leaveParagraph(); }
    vi.advanceTimersByTime(4000);
    expect(globalThis.chrome._store.sra_time_model_by_lang.en.n).toBeGreaterThan(0);
    const again = createComprehensionMonitor();
    expect(again.getTimeModelCoefficients('en')).toEqual(m.getTimeModelCoefficients('en'));
  });
});

describe('very hard paragraphs are judged like any other', () => {
  it('a paragraph far slower than even a very hard paragraph should take is flagged (it used to be skipped)', () => {
    const m = createComprehensionMonitor();
    for (let i = 0; i < 6; i++) { m.enterParagraph(el(EASY(120))); vi.advanceTimersByTime(25000); m.leaveParagraph(); }
    expect(analyzeDifficulty(VERY_HARD, { lang: 'en' }).grade).toBe('very_difficult');
    m.enterParagraph(el(VERY_HARD));
    const exp = m.getCurrentExpectation().expectedMs;
    vi.advanceTimersByTime(Math.round(exp * 3.5));
    const sig = m.leaveParagraph();
    expect(sig && sig.subtype).toBe('too_slow');
  });

  it('but a very hard paragraph read in about the time it should take is not flagged', () => {
    const m = createComprehensionMonitor();
    for (let i = 0; i < 6; i++) { m.enterParagraph(el(EASY(120))); vi.advanceTimersByTime(25000); m.leaveParagraph(); }
    m.enterParagraph(el(VERY_HARD));
    const exp = m.getCurrentExpectation().expectedMs;
    vi.advanceTimersByTime(Math.round(exp * 1.1));
    expect(m.leaveParagraph()).toBeNull();
  });
});

describe('word lists for French, Spanish, German, Portuguese and Italian', () => {
  const dir = path.resolve(__dirname, '..', 'alcoia', 'src', 'libs', 'wordfreq');

  it('each list exists, is 5,000 words, and carries its source and licence in the header', () => {
    for (const lang of LEXICON_LANGUAGES) {
      const src = fs.readFileSync(path.join(dir, `common-words-${lang}.js`), 'utf8');
      expect(src).toMatch(/CC BY-SA 4\.0/);
      expect(src).toMatch(/FrequencyWords/);
      const words = JSON.parse(src.slice(src.indexOf('new Set(') + 8, src.lastIndexOf(');')));
      expect(words).toHaveLength(5000);
    }
  });

  it('nothing is reported for these languages until their list has loaded, or for other languages', async () => {
    expect(lexicalRarity('Le petit chat dort sur le canapé de la maison.', 'fr').available).toBe(false);
    expect(lexicalRarity('猫がソファで寝ています', 'ja').available).toBe(false);
    expect(await loadLexicon('ja')).toBe(false);
  });

  it('after loading, ordinary prose has few rare words and technical prose has many', async () => {
    const samples = {
      fr: ['Je pense que nous allons aller au marché demain matin avec les enfants.', 'La spectrométrie ultraviolette caractérise chimiquement les hydrocarbures polycycliques aromatiques.'],
      es: ['Creo que vamos a ir al mercado mañana por la mañana con los niños.', 'La espectrometría ultravioleta caracteriza químicamente los hidrocarburos policíclicos aromáticos.'],
      de: ['Ich glaube, wir gehen morgen früh mit den Kindern auf den Markt.', 'Die ultraviolette Spektrometrie charakterisiert polyzyklische aromatische Kohlenwasserstoffe chemisch.'],
      pt: ['Acho que vamos ao mercado amanhã de manhã com as crianças.', 'A espectrometria ultravioleta caracteriza quimicamente os hidrocarbonetos policíclicos aromáticos.'],
      it: ['Penso che andremo al mercato domani mattina con i bambini.', 'La spettrometria ultravioletta caratterizza chimicamente gli idrocarburi policiclici aromatici.'],
    };
    for (const lang of LEXICON_LANGUAGES) {
      expect(await loadLexicon(lang)).toBe(true);
      const plain = lexicalRarity(samples[lang][0], lang);
      const dense = lexicalRarity(samples[lang][1], lang);
      expect(plain.available).toBe(true);
      expect(plain.rareRatio).toBeLessThan(0.3);
      expect(dense.rareRatio).toBeGreaterThan(plain.rareRatio + 0.3);
    }
  });

  it('the share reaches the analysis for those languages, without changing their difficulty score', async () => {
    await loadLexicon('fr');
    const text = 'Le petit chat dort sur le canapé de la maison. Il fait beau aujourd\'hui, et les enfants jouent dans le jardin avec leurs amis. '.repeat(3);
    const withList = analyzeDifficulty(text, { lang: 'fr' });
    expect(withList.lexical.available).toBe(true);
    const score = withList.score;
    expect(score).toBeCloseTo(withList.syntactic.score * 0.6 + withList.propositional.score * 0.4, 5);
  });
});

describe('screen timing', () => {
  const make = () => {
    let t = 0;
    const st = createScreenTiming({ now: () => t, viewportHeight: () => 800 });
    return { st, at: (ms) => { t = ms; } };
  };
  const jumpAt = (h, ms, y) => { h.at(ms); return h.st.noteScroll(y); };

  it('three screen jumps in a row put the reader in screen mode, and the time between jumps is the time on a screen', () => {
    const h = make();
    jumpAt(h, 1000, 0);
    jumpAt(h, 61000, 800);
    jumpAt(h, 121000, 1600);
    jumpAt(h, 181000, 2400);
    const stay = jumpAt(h, 241000, 3200);
    expect(h.st.isScreenMode()).toBe(true);
    expect(stay).toEqual({ dwellMs: 60000, settleY: 2400 });
  });

  it('smooth scrolling in small steps is never a screen jump', () => {
    const h = make();
    for (let i = 0; i < 60; i++) jumpAt(h, 1000 + i * 120, i * 25);
    expect(h.st.isScreenMode()).toBe(false);
  });

  it('a smooth animated page-down (many small events in one burst) still counts as one jump', () => {
    const h = make();
    let ms = 0;
    for (let jump = 0; jump < 5; jump++) {
      for (let step = 1; step <= 10; step++) { ms += 30; h.at(ms); h.st.noteScroll(jump * 800 + step * 80); }
      ms += 30000;
    }
    expect(h.st.isScreenMode()).toBe(true);
  });

  it('time away is not time on the screen, and stays outside the allowed range are dropped', () => {
    const h = make();
    jumpAt(h, 1000, 0); jumpAt(h, 61000, 800); jumpAt(h, 121000, 1600); jumpAt(h, 181000, 2400);
    h.st.shiftTime(20000);
    expect(jumpAt(h, 241000, 3200).dwellMs).toBe(40000);
    jumpAt(h, 242000, 4000);
    expect(jumpAt(h, 242000 + SCREEN.MAX_DWELL_MS + 1000, 4800)).toBeNull();
    jumpAt(h, 700000, 5600);
    expect(jumpAt(h, 700000 + 500, 6400)).toBeNull(); // under the minimum stay
  });
});

describe('screen mode in the comprehension monitor', () => {
  const PARA_H = 200;
  const PARAS = 120;

  function buildPage() {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    for (let i = 0; i < PARAS; i++) {
      const p = document.createElement('p');
      p.textContent = `Paragraph ${i}. ${EASY(100)}`;
      p.getBoundingClientRect = () => {
        const top = i * PARA_H - window.scrollY;
        return { top, bottom: top + PARA_H, height: PARA_H, left: 0, right: 600, width: 600 };
      };
      document.body.appendChild(p);
    }
  }
  const jump = (m, y, stayMs) => { vi.advanceTimersByTime(stayMs); scrollTo(y); return m.onScroll(); };

  it('a reader who reads a screen at a time is timed per screen: an unusually long stay on one screen is flagged', () => {
    buildPage();
    const m = createComprehensionMonitor();
    let y = 0;
    const stays = [60000, 66000, 57000, 63000, 59000, 64000, 61000, 58000, 65000, 62000, 60000, 67000, 60000];
    for (const stay of stays) { y += 800; jump(m, y, stay); }
    expect(m.isScreenMode()).toBe(true);
    y += 800;
    const flagged = jump(m, y, 240000);      // a stay four times as long as this reader's usual
    expect(flagged && flagged.type).toBe('speed_mismatch');
    expect(flagged.subtype).toBe('too_slow');
    expect(flagged.screen).toBe(true);
    expect(flagged.reliability.unit).toBe('screen');
    expect(flagged.expectedRatio).toBeGreaterThan(3);
    expect(flagged.elapsed).toBe(240000);
  });

  it('a reader who is not jumping by screens is not in screen mode, and paragraph timing still works', () => {
    buildPage();
    const m = createComprehensionMonitor();
    for (let i = 0; i < 30; i++) { vi.advanceTimersByTime(400); scrollTo(i * 30); m.onScroll(); }
    expect(m.isScreenMode()).toBe(false);
    for (let i = 0; i < 6; i++) { m.enterParagraph(el(EASY(120))); vi.advanceTimersByTime(25000); m.leaveParagraph(); }
    expect(m.getBaselineWpm()).toBeGreaterThan(0);
  });

  it('while in screen mode the per-paragraph path stays quiet instead of mis-timing a paragraph', () => {
    buildPage();
    const m = createComprehensionMonitor();
    let y = 0;
    for (let i = 0; i < 12; i++) { y += 800; jump(m, y, 60000); }
    expect(m.isScreenMode()).toBe(true);
    expect(m.getBaselineWpm()).toBeGreaterThan(0);
    m.enterParagraph(el(EASY(120)));
    vi.advanceTimersByTime(600000);
    expect(m.leaveParagraph()).toBeNull();
  });
});
