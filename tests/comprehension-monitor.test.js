// @vitest-environment jsdom
/* comprehension-monitor.js had no test file: nothing covered the running
 * median WPM baseline, its chrome.storage persistence, the speed-mismatch
 * thresholds, or — the one that matters most — the reader-to-self comparison
 * that is supposed to stop the system quizzing a slow reader for reading
 * slowly. This file closes that gap directly against the real module, not a
 * fake standing in for it.
 *
 * comprehension-monitor.js reads Date.now() directly rather than accepting an
 * injected clock, so time is controlled with vi's fake timers throughout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createComprehensionMonitor } from '../alcoia/src/content/comprehension-monitor.js';
import { analyzeDifficulty } from '../alcoia/src/content/signals/text-difficulty.js';

// Short sentences, simple words: scores as 'easy' (>=80), which is one of the
// two grades the WPM baseline is allowed to learn from.
const EASY = (n) => {
  const s = 'The cat sat on the mat and looked at the dog. ';
  return s.repeat(Math.ceil(n / 10)).trim();
};

// Longer sentences, several subordinators, real punctuation: scores as
// 'difficult' (40-59), not 'very_difficult' — the too_slow path explicitly
// excludes very_difficult text, so a 'difficult' fixture is what exercises
// it. Item 13c: strengthened from an earlier, lighter version — that one
// used almost entirely common words (committee, proposal, members,
// amendment...), so once lexicalRarity()/propositionalDensity() started
// contributing real signal alongside FK/syntacticLoad(), it scored right
// at the MIN_DIFFICULTY boundary rather than robustly below it. More
// subordination and clause nesting gives this a real margin under the new
// four-input blend, not just the syllable-heavy FK score it was mostly
// riding on before.
const DIFFICULT = (n) => {
  const s = 'The committee reviewed the proposal because several members believed it needed further amendment, although the initial draft, which had been carefully prepared, remained contentious. '
    + 'Whereas the delegates whom the chairperson consulted had expressed considerable disagreement, insofar as the underlying assumptions were themselves subject to dispute, no resolution was reached. ';
  return s.repeat(Math.ceil(n / 40)).trim();
};

function el(text) { return { innerText: text, textContent: text }; }

function fakeChromeStorage(seed = {}) {
  const store = { ...seed };
  return {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
          cb(result);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
      },
    },
    _store: store,
  };
}

function scrollTo(y) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  document.documentElement.lang = 'en';
  scrollTo(0);
  globalThis.chrome = fakeChromeStorage();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.chrome;
});

describe('paragraph entry', () => {
  it('ignores a paragraph under the word-count floor', () => {
    const m = createComprehensionMonitor();
    m.enterParagraph(el('too short to matter'));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph()).toBeNull();
  });

  it('says nothing when nothing was entered', () => {
    const m = createComprehensionMonitor();
    expect(m.leaveParagraph()).toBeNull();
  });

  it('reports the current expectation while a paragraph is active, and null otherwise', () => {
    const m = createComprehensionMonitor();
    expect(m.getCurrentExpectation()).toBeNull();
    m.enterParagraph(el(EASY(120)));
    const exp = m.getCurrentExpectation();
    expect(exp.expectedMs).toBeGreaterThan(0);
    expect(exp.enteredAt).toBe(Date.now());
  });
});

describe('personal WPM baseline', () => {
  it('is null until 5 samples exist, then becomes the running median', () => {
    const m = createComprehensionMonitor();
    expect(m.getBaselineWpm()).toBeNull();

    const text = EASY(120);
    const wordCount = analyzeDifficulty(text, { lang: 'en' }).wordCount;
    const elapsedMs = 25000;
    const expectedWpm = Math.round((wordCount / elapsedMs) * 60000);

    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(elapsedMs);
      m.leaveParagraph();
    }
    expect(m.getBaselineWpm()).toBe(expectedWpm);
  });

  it('persists the legacy baseline key once established, and a fresh monitor hydrates from it', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(20000);
      m.leaveParagraph();
    }
    const persisted = globalThis.chrome._store.sra_baseline_wpm;
    expect(persisted).toBeGreaterThan(0);
    expect(persisted).toBe(m.getBaselineWpm());

    globalThis.chrome = fakeChromeStorage({ sra_baseline_wpm: persisted, sra_baseline_wpm_by_lang: {} });
    const fresh = createComprehensionMonitor();
    expect(fresh.getBaselineWpm()).toBe(persisted);
  });

  it('persists a per-language baseline map after the debounce window', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(20000);
      m.leaveParagraph();
    }
    vi.advanceTimersByTime(2000);   // flush the debounced write
    expect(globalThis.chrome._store.sra_baseline_wpm_by_lang).toEqual({ en: m.getBaselineWpm() });
  });
});

describe('speed-mismatch thresholds', () => {
  it('flags dense text read implausibly fast', () => {
    const m = createComprehensionMonitor();
    m.enterParagraph(el(DIFFICULT(80)));
    vi.advanceTimersByTime(5000);   // well under the ~39s a 160wpm generic reader would take
    const sig = m.leaveParagraph();
    expect(sig.type).toBe('speed_mismatch');
    expect(sig.subtype).toBe('too_fast');
  });

  it('flags a paragraph read far slower than the reader’s own established baseline', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    const steady = 25000;
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(steady);
      m.leaveParagraph();
    }
    const baseline = m.getBaselineWpm();
    expect(baseline).toBeGreaterThan(0);

    m.enterParagraph(el(text));
    vi.advanceTimersByTime(steady * 3);   // a third of their own established pace
    const sig = m.leaveParagraph();
    expect(sig.type).toBe('speed_mismatch');
    expect(sig.subtype).toBe('too_slow');
    expect(sig.baselineWpm).toBe(baseline);
  });

  it('suppresses further offers during the cooldown window, and resumes after it', () => {
    const m = createComprehensionMonitor();
    const text = DIFFICULT(80);

    m.enterParagraph(el(text));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph().subtype).toBe('too_fast');
    m.markOfferShown();

    m.enterParagraph(el(text));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph()).toBeNull();   // same qualifying read, still cooling down

    vi.advanceTimersByTime(30000);           // COOLDOWN_MS
    m.enterParagraph(el(text));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph().subtype).toBe('too_fast');
  });
});

describe('the fairness safeguard: unusual for this reader, not unusual by a fixed rule', () => {
  it('stops flagging a reader’s own steady-but-slow pace once it has learned that pace, while still catching a real outlier', () => {
    const m = createComprehensionMonitor();

    // hasSamples() — the gate too_slow requires — only counts real samples
    // accumulated this session; seedWpmFromCalibration() alone isn't enough
    // (it seeds a value, not a sample count). Establish it the same way a
    // real session would: five ordinary easy paragraphs read at a steady
    // pace. Difficult-text reads never contribute to the baseline (only
    // standard/easy do), so once this is set it stays fixed as the yardstick
    // for every "slow" read below.
    const warmupText = EASY(120);
    const warmupWordCount = analyzeDifficulty(warmupText, { lang: 'en' }).wordCount;
    const warmupElapsed = Math.round((warmupWordCount / 250) * 60000);   // targets ~250 wpm
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(warmupText));
      vi.advanceTimersByTime(warmupElapsed);
      m.leaveParagraph();
    }
    const baseline = m.getBaselineWpm();
    expect(baseline).toBeGreaterThan(0);

    const text = DIFFICULT(90);   // grade 'difficult': eligible for too_slow, and excluded from the baseline itself
    const wordCount = analyzeDifficulty(text, { lang: 'en' }).wordCount;
    const expectedMs = wordCount / (baseline * 0.72) * 60000; // expectedReadingMs's own difficulty multiplier for 'difficult'

    const read = (ratio) => {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(Math.round(ratio * expectedMs));
      return m.leaveParagraph();
    };

    // First-ever read: this reader is consistently slower than the model,
    // but there is no history yet, so the fixed 50%-of-baseline rule alone
    // judges it — and flags it, which is exactly the "quizzed for reading
    // slowly" failure mode the fairness comparison exists to prevent.
    const first = read(1.8);
    expect(first.type).toBe('speed_mismatch');
    expect(first.subtype).toBe('too_slow');
    m.markOfferShown();

    // Give it 30s of headroom past the cooldown before continuing, then
    // build eight more readings at essentially the same personal pace (with
    // the small natural variation any real session would have) so the
    // reader's own residual distribution has enough history to trust.
    vi.advanceTimersByTime(30000);
    const ramp = [1.75, 1.8, 1.85, 1.9, 1.75, 1.85, 1.8];
    for (const ratio of ramp) {
      read(ratio);
      vi.advanceTimersByTime(30000);   // clear the cooldown between samples
    }

    // Same pace as always for this reader. It is no longer unusual *for
    // them*, so it must not fire — even though it is still well under 50%
    // of the fixed baseline, the rule that flagged the very first read.
    const typical = read(1.8);
    expect(typical).toBeNull();
    vi.advanceTimersByTime(30000);

    // A genuine outlier — far slower than even this reader's own slow norm —
    // must still be caught. The safeguard raises the bar to "unusual for
    // this reader"; it does not switch struggle detection off.
    const outlier = read(6);
    expect(outlier.type).toBe('speed_mismatch');
    expect(outlier.subtype).toBe('too_slow');
  });
});

describe('personal WPM baseline: resistance to outliers', () => {
  it('a single implausibly fast read does not drag the running median', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    const wordCount = analyzeDifficulty(text, { lang: 'en' }).wordCount;
    const steadyMs = Math.round((wordCount / 250) * 60000);   // ~250 wpm, steady

    for (let i = 0; i < 9; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(steadyMs);
      m.leaveParagraph();
    }
    const baseline = m.getBaselineWpm();
    expect(baseline).toBeGreaterThan(200);
    expect(baseline).toBeLessThan(300);

    // add() only rejects values outside [30, 900], so this one point is
    // accepted as a sample — but a median of ten values where nine cluster
    // near 250 and one sits at 850 is unmoved by it; a running mean would
    // have been dragged toward 850 by roughly 60 wpm.
    m.enterParagraph(el(text));
    vi.advanceTimersByTime(Math.round((wordCount / 850) * 60000));
    m.leaveParagraph();

    expect(m.getBaselineWpm()).toBe(baseline);
  });
});

describe('expected reading time scales with word count and difficulty', () => {
  it('scales roughly in proportion with word count, for a fixed grade and baseline', () => {
    const m = createComprehensionMonitor();
    m.seedWpmFromCalibration(240, 'en');

    const shortText = EASY(100);   // comfortably over MIN_WORD_COUNT (70)
    const longText  = EASY(300);
    const shortWords = analyzeDifficulty(shortText, { lang: 'en' }).wordCount;
    const longWords  = analyzeDifficulty(longText,  { lang: 'en' }).wordCount;

    m.enterParagraph(el(shortText));
    const shortMs = m.getCurrentExpectation().expectedMs;
    m.leaveParagraph();

    m.enterParagraph(el(longText));
    const longMs = m.getCurrentExpectation().expectedMs;
    m.leaveParagraph();

    const wordRatio = longWords / shortWords;
    const msRatio    = longMs / shortMs;
    expect(msRatio).toBeGreaterThan(wordRatio * 0.8);
    expect(msRatio).toBeLessThan(wordRatio * 1.2);
  });

  it('expects more time per word for a harder grade than an easier one, once a baseline exists', () => {
    const m = createComprehensionMonitor();
    m.seedWpmFromCalibration(240, 'en');

    const easyText = EASY(150);
    const hardText = DIFFICULT(150);
    const easyWords = analyzeDifficulty(easyText, { lang: 'en' }).wordCount;
    const hardWords = analyzeDifficulty(hardText, { lang: 'en' }).wordCount;

    m.enterParagraph(el(easyText));
    const easyMsPerWord = m.getCurrentExpectation().expectedMs / easyWords;
    m.leaveParagraph();

    m.enterParagraph(el(hardText));
    const hardMsPerWord = m.getCurrentExpectation().expectedMs / hardWords;
    m.leaveParagraph();

    expect(hardMsPerWord).toBeGreaterThan(easyMsPerWord);
  });
});

/* CLAUDE.md invariant 5: "unknown is a valid, correct, common state... never
 * substitute plausible defaults for missing data." text-difficulty.js's
 * syntacticLoad() names the case where it cannot measure structure at all
 * (structureIsUnreadable(): a script like Thai or Khmer with no terminal
 * punctuation, so the whole paragraph parses as one "sentence") and returns
 * `score: 60, grade: 'standard'` for it anyway, labelled
 * `basis: 'structure_unavailable'` so a caller could tell the difference.
 *
 * Item 7 documented this here as a finding: comprehension-monitor.js never
 * checked `basis` and treated the placeholder exactly like a real 'standard'
 * grade, for baseline calibration and speed-mismatch comparisons alike — a
 * plausible default standing in for missing data, which invariant 5
 * forbids. Item 24 closed the gap: enterParagraph() now checks `basis` and
 * abstains outright when structure is unmeasurable, leaving
 * `paragraphEntry` unset so the paragraph never contributes an expectation,
 * a WPM sample, a residual, or a speed_mismatch signal. */
describe('difficulty basis: structure unavailable (item 24 — abstains, does not guess)', () => {
  it('text-difficulty.js still labels the case and still returns a placeholder score', () => {
    // detectLanguage() caches its result against `document` for 5s; earlier
    // tests in this file already primed that cache for 'en' at this same
    // fake-timer instant, so it has to be pushed stale before the language
    // change below will actually take effect.
    // detectLanguage()'s cache is module-level and keyed on `document`
    // identity + a 5s TTL against Date.now() — not reset between tests.
    // beforeEach resets the fake clock to the *same* fixed instant every
    // test, so a prior test that advanced its own clock further before
    // writing the cache can leave langCache.at ahead of this test's fresh
    // start, making a small advance look "still fresh" by comparison. A
    // day comfortably exceeds any cumulative advance any single test in
    // this file performs, so it reliably busts the cache regardless of
    // execution order.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    document.documentElement.lang = 'th';

    // No sentence-terminal punctuation anywhere and > 60 words: exactly the
    // condition structureIsUnreadable() exists to catch.
    const text = Array(90).fill('word').join(' ');
    const r = analyzeDifficulty(text, { lang: 'th' });
    expect(r.basis).toBe('structure_unavailable');
    expect(r.grade).toBe('standard');
    expect(r.score).toBe(60);
  });

  it('comprehension-monitor.js abstains instead of proceeding on the placeholder', () => {
    // detectLanguage()'s cache is module-level and keyed on `document`
    // identity + a 5s TTL against Date.now() — not reset between tests.
    // beforeEach resets the fake clock to the *same* fixed instant every
    // test, so a prior test that advanced its own clock further before
    // writing the cache can leave langCache.at ahead of this test's fresh
    // start, making a small advance look "still fresh" by comparison. A
    // day comfortably exceeds any cumulative advance any single test in
    // this file performs, so it reliably busts the cache regardless of
    // execution order.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    document.documentElement.lang = 'th';
    const text = Array(90).fill('word').join(' ');

    const m = createComprehensionMonitor();
    m.enterParagraph(el(text));
    // No expectation at all — not null-because-nothing-is-being-timed, but
    // specifically because this paragraph was never entered.
    expect(m.getCurrentExpectation()).toBeNull();
    // leaveParagraph() must be a no-op too: no residual, no speed_mismatch,
    // no WPM sample.
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph()).toBeNull();
    expect(m.getResidualStats().n).toBe(0);
  });

  it('does not contribute to the WPM baseline even after many such paragraphs', () => {
    // detectLanguage()'s cache is module-level and keyed on `document`
    // identity + a 5s TTL against Date.now() — not reset between tests.
    // beforeEach resets the fake clock to the *same* fixed instant every
    // test, so a prior test that advanced its own clock further before
    // writing the cache can leave langCache.at ahead of this test's fresh
    // start, making a small advance look "still fresh" by comparison. A
    // day comfortably exceeds any cumulative advance any single test in
    // this file performs, so it reliably busts the cache regardless of
    // execution order.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    document.documentElement.lang = 'th';
    const text = Array(90).fill('word').join(' ');

    const m = createComprehensionMonitor();
    for (let i = 0; i < 10; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(20000); // plausible reading time, irrelevant here
      m.leaveParagraph();
    }

    // getBaselineWpm() (no argument) only ever reports the 'en'/fallback
    // bucket, which this test never touches either way — asserting on it
    // directly would pass regardless of whether the abstention fix works,
    // since WpmRegistry keys baselines per language and 'th' is a separate
    // bucket. Probe the 'th' bucket specifically the only way the public
    // API allows: enter one genuinely measurable 'th' paragraph and check
    // that its expected reading time still comes from the generic
    // per-grade constant (comprehension-monitor.js's GENERIC_WPM), not a
    // personalised figure — which is only possible if the ten unmeasurable
    // "readings" above never seeded a personal baseline for 'th'.
    const probeText = EASY(90); // short real sentences — genuinely measurable
    m.enterParagraph(el(probeText));
    const exp = m.getCurrentExpectation();
    expect(exp).not.toBeNull();
    const r = analyzeDifficulty(probeText, { lang: 'th' });
    expect(r.basis).not.toBe('structure_unavailable'); // confirms the probe is real
    const GENERIC_WPM_STANDARD = 220; // comprehension-monitor.js's GENERIC_WPM.standard
    const GENERIC_WPM_EASY = 260;     // comprehension-monitor.js's GENERIC_WPM.easy
    const expectedGenericMs = (r.wordCount / (r.grade === 'easy' ? GENERIC_WPM_EASY : GENERIC_WPM_STANDARD)) * 60000;
    expect(exp.expectedMs).toBeCloseTo(expectedGenericMs, 0);
  });

  it('a genuinely unpunctuated but short (<=60-word) paragraph is unaffected', () => {
    // structureIsUnreadable() requires wordCount > 60 — this isolates that
    // exact boundary (via text-difficulty.js directly, which has no word
    // floor of its own) so the abstention path is confirmed to trigger only
    // on the condition it's meant for, not on every sentence-less paragraph.
    // detectLanguage()'s cache is module-level and keyed on `document`
    // identity + a 5s TTL against Date.now() — not reset between tests.
    // beforeEach resets the fake clock to the *same* fixed instant every
    // test, so a prior test that advanced its own clock further before
    // writing the cache can leave langCache.at ahead of this test's fresh
    // start, making a small advance look "still fresh" by comparison. A
    // day comfortably exceeds any cumulative advance any single test in
    // this file performs, so it reliably busts the cache regardless of
    // execution order.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    document.documentElement.lang = 'th';
    const text = Array(60).fill('word').join(' '); // exactly at the boundary, not over it

    const r = analyzeDifficulty(text, { lang: 'th' });
    expect(r.basis).not.toBe('structure_unavailable'); // 60 is not > 60
    expect(r.basis).toBe('syntactic');
  });

  it('backtrack detection is untouched on a page made entirely of unmeasurable text', () => {
    // Backtrack reads window.scrollY, never paragraphEntry or readability —
    // confirming the extension still functions, just more quietly, exactly
    // as this item asked to verify rather than assume.
    // detectLanguage()'s cache is module-level and keyed on `document`
    // identity + a 5s TTL against Date.now() — not reset between tests.
    // beforeEach resets the fake clock to the *same* fixed instant every
    // test, so a prior test that advanced its own clock further before
    // writing the cache can leave langCache.at ahead of this test's fresh
    // start, making a small advance look "still fresh" by comparison. A
    // day comfortably exceeds any cumulative advance any single test in
    // this file performs, so it reliably busts the cache regardless of
    // execution order.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    document.documentElement.lang = 'th';
    const text = Array(90).fill('word').join(' ');

    const m = createComprehensionMonitor();
    m.enterParagraph(el(text)); // abstains — paragraphEntry stays null
    expect(m.getCurrentExpectation()).toBeNull();

    for (const y of [100, 250, 400, 500]) {
      scrollTo(y);
      expect(m.onScroll()).toBeNull();
      vi.advanceTimersByTime(200);
    }
    scrollTo(50);
    const signal = m.onScroll();
    expect(signal.type).toBe('backtrack');
    expect(signal.backtrackPx).toBe(450);
  });
});

describe('scroll backtrack', () => {
  it('flags scrolling down and then sharply back up', () => {
    const m = createComprehensionMonitor();
    for (const y of [100, 250, 400, 500]) {
      scrollTo(y);
      expect(m.onScroll()).toBeNull();
      vi.advanceTimersByTime(200);
    }
    scrollTo(50);
    const sig = m.onScroll();
    expect(sig.type).toBe('backtrack');
    expect(sig.backtrackPx).toBe(450);
  });

  it('ignores small movements back up', () => {
    const m = createComprehensionMonitor();
    for (const y of [100, 150, 200, 250]) {
      scrollTo(y);
      expect(m.onScroll()).toBeNull();
      vi.advanceTimersByTime(200);
    }
    scrollTo(220);   // a 30px correction, not a regression
    expect(m.onScroll()).toBeNull();
  });
});
