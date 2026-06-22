/* comprehension-monitor.js
   Detects readers who appear focused but may not be understanding the content.

   Signals produced:
   1. speed_mismatch (too fast) — difficult paragraph read faster than expected
   2. speed_mismatch (too slow) — paragraph read at <50% of personal baseline WPM,
      indicating silent struggle the gaze classifier might miss
   3. backtrack — user scrolled down then immediately back up

   Personal WPM baseline:
   Built from the user's actual measured WPM across the session (running median
   of standard-difficulty paragraphs). After 5 samples, this replaces the generic
   WPM constants. Stored in chrome.storage so it persists across sessions.
   Can also be seeded from the reading calibration (see content.js).

   Non-English pages: Flesch-Kincaid is English-only, so FK-based signals are
   skipped on non-English pages. Scroll backtrack works for all languages.
*/

// ── Syllable / readability ─────────────────────────────────────────────────────
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

function fleschKincaid(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words     = text.split(/\s+/).filter(w => w.trim().length > 0);
  if (!sentences.length || !words.length) return { score: 60, grade: 'standard', wordCount: 0 };

  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  const wps  = words.length / sentences.length;
  const spw  = syllables / words.length;
  const raw  = 206.835 - 1.015 * wps - 84.6 * spw;
  const score = Math.max(0, Math.min(100, raw));

  let grade;
  if (score >= 80)      grade = 'easy';
  else if (score >= 60) grade = 'standard';
  else if (score >= 40) grade = 'difficult';
  else                  grade = 'very_difficult';

  return { score, grade, wps, spw, wordCount: words.length };
}

// Generic WPM for typical readers (used before personal baseline is established)
const GENERIC_WPM = { easy: 260, standard: 220, difficult: 160, very_difficult: 110 };

function expectedReadingMs(readability, baselineWpm) {
  const wpm = baselineWpm
    ? baselineWpm * ({ easy: 1.15, standard: 1.0, difficult: 0.72, very_difficult: 0.50 }[readability.grade] ?? 1)
    : GENERIC_WPM[readability.grade] ?? 200;
  return readability.wordCount > 0 ? (readability.wordCount / wpm) * 60000 : 0;
}

function isEnglishPage() {
  const lang = (
    document.documentElement.lang ||
    document.querySelector('meta[http-equiv="content-language"]')?.content ||
    navigator.language || 'en'
  ).toLowerCase().slice(0, 2);
  return lang === 'en' || lang === '';
}

// ── WPM baseline ───────────────────────────────────────────────────────────────
// Running median of standard-difficulty paragraph WPMs from this session.
// Seeded from chrome.storage on creation; updated continuously.
class WpmBaseline {
  constructor(seed) {
    this._samples = [];
    this._stored  = seed || null;
  }

  // Add a WPM observation for a paragraph of the given difficulty grade
  add(wpm, grade) {
    if (wpm < 30 || wpm > 900) return;       // filter implausible values
    if (grade !== 'standard' && grade !== 'easy') return; // only calibrate on normal text
    this._samples.push(wpm);
    if (this._samples.length > 30) this._samples.shift(); // rolling window
    if (this._samples.length >= 5) {
      // Update stored baseline as the median of recent samples
      const sorted = [...this._samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      this._stored = Math.round(median);
      try {
        chrome.storage.local.set({ sra_baseline_wpm: this._stored });
      } catch (e) {}
    }
  }

  // Seed with WPM measured during reading calibration
  seedFromCalibration(wpm) {
    if (wpm && wpm > 30 && wpm < 900) {
      this._stored = wpm;
      this._samples = [wpm, wpm]; // give it some weight so it influences median
      try { chrome.storage.local.set({ sra_baseline_wpm: wpm }); } catch (e) {}
    }
  }

  get() { return this._stored; }
  hasSamples() { return this._samples.length >= 5; }
}

// ── Public factory ─────────────────────────────────────────────────────────────
export function createComprehensionMonitor(opts = {}) {
  const SPEED_RATIO_FAST   = opts.speedRatio     || 0.30;  // <30% of expected = too fast
  const SPEED_RATIO_SLOW   = 0.50;                          // <50% of personal baseline = too slow
  const MIN_WORD_COUNT     = opts.minWords        || 70;
  const MIN_DIFFICULTY     = opts.minDifficulty   || 58;    // FK score < 58 = dense enough to monitor
  const BACKTRACK_WINDOW   = opts.backtrackWindow || 4000;
  const COOLDOWN_MS        = opts.cooldown        || 30000;

  let lastOfferAt    = 0;
  let paragraphEntry = null;
  let recentScrollY  = [];
  let lastScrollY    = window.scrollY;

  // Load persisted WPM baseline
  let wpmBaseline = new WpmBaseline(null);
  try {
    chrome.storage.local.get({ sra_baseline_wpm: null }, (r) => {
      if (r.sra_baseline_wpm) wpmBaseline = new WpmBaseline(r.sra_baseline_wpm);
    });
  } catch (e) {}

  function enterParagraph(el) {
    if (!el) return;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.split(/\s+/).length < MIN_WORD_COUNT) return;
    const readability = fleschKincaid(text);
    paragraphEntry = { el, text, readability, enteredAt: Date.now() };
  }

  function leaveParagraph() {
    if (!paragraphEntry) return null;
    const entry    = paragraphEntry;
    paragraphEntry = null;
    const elapsed  = Date.now() - entry.enteredAt;
    const r        = entry.readability;

    // Always track WPM for baseline building (any language, any difficulty)
    if (elapsed > 1000 && r.wordCount > 0) {
      const wpm = Math.round((r.wordCount / elapsed) * 60000);
      wpmBaseline.add(wpm, r.grade);
    }

    // FK-based signals only on English pages
    if (!isEnglishPage()) return null;
    if (Date.now() - lastOfferAt < COOLDOWN_MS) return null;

    const expected = expectedReadingMs(r, wpmBaseline.get());
    if (expected <= 0) return null;
    const ratio = elapsed / expected;

    // Too fast through difficult text
    if (r.score < MIN_DIFFICULTY && ratio < SPEED_RATIO_FAST && r.wordCount >= MIN_WORD_COUNT) {
      return {
        type: 'speed_mismatch', subtype: 'too_fast',
        el: entry.el, text: entry.text, readability: r,
        ratio, elapsed, expected,
      };
    }

    // Too slow compared to personal baseline (silent struggle)
    if (wpmBaseline.hasSamples() && elapsed > 3000 && r.wordCount >= 40) {
      const baseWpm     = wpmBaseline.get();
      const actualWpm   = (r.wordCount / elapsed) * 60000;
      const slowRatio   = actualWpm / baseWpm;
      if (slowRatio < SPEED_RATIO_SLOW && r.grade !== 'very_difficult') {
        return {
          type: 'speed_mismatch', subtype: 'too_slow',
          el: entry.el, text: entry.text, readability: r,
          ratio: slowRatio, actualWpm: Math.round(actualWpm), baselineWpm: baseWpm,
        };
      }
    }

    return null;
  }

  function onScroll() {
    const now      = Date.now();
    const currentY = window.scrollY;
    const delta    = currentY - lastScrollY;
    lastScrollY    = currentY;

    recentScrollY.push({ y: currentY, t: now });
    recentScrollY = recentScrollY.filter(p => now - p.t < 8000);

    // Backtrack: scrolled down recently, now going back up significantly
    // (works for all languages — no FK dependency)
    if (delta < -80 && recentScrollY.length > 3) {
      const windowStart = now - BACKTRACK_WINDOW;
      const recent = recentScrollY.filter(p => p.t > windowStart);
      if (recent.length > 0) {
        const maxY = Math.max(...recent.map(p => p.y));
        if (maxY - currentY > 150 && now - lastOfferAt > COOLDOWN_MS) {
          return { type: 'backtrack', backtrackPx: maxY - currentY };
        }
      }
    }
    return null;
  }

  function markOfferShown() { lastOfferAt = Date.now(); }

  function seedWpmFromCalibration(wpm) { wpmBaseline.seedFromCalibration(wpm); }

  return {
    enterParagraph, leaveParagraph, onScroll, markOfferShown,
    seedWpmFromCalibration, fleschKincaid,
    getBaselineWpm: () => wpmBaseline.get(),
  };
}
