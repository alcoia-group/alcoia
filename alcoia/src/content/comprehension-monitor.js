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

   Non-English pages: Flesch-Kincaid is English-only. Difficulty on those pages
   now comes from syntactic structure instead (clause length, sentence length,
   subordination) via text-difficulty.js, so speed signals work there too.
   Previously every FK-based check was skipped and those pages produced nothing
   but scroll backtrack.

   Thresholds: once ~8 paragraphs of history exist, "too fast" and "too slow"
   are judged against the reader's own distribution of reading-rate residuals
   rather than fixed ratios. A reader who consistently runs at 0.6x the model
   is not struggling on every paragraph, and a fixed cutoff would say they are.
*/

// ── Readability ────────────────────────────────────────────────────────────────
// Flesch-Kincaid plus syntactic proxies. The syntactic half is what makes
// non-English pages produce a difficulty signal at all — see text-difficulty.js.
import { analyzeDifficulty, fleschKincaid } from './signals/text-difficulty.js';
import { countWords, detectLanguage } from './signals/segmentation.js';
import { ResidualDistribution } from './signals/residual-distribution.js';

// Generic WPM for typical readers (used before personal baseline is established)
const GENERIC_WPM = { easy: 260, standard: 220, difficult: 160, very_difficult: 110 };

function expectedReadingMs(readability, baselineWpm) {
  const wpm = baselineWpm
    ? baselineWpm * ({ easy: 1.15, standard: 1.0, difficult: 0.72, very_difficult: 0.50 }[readability.grade] ?? 1)
    : GENERIC_WPM[readability.grade] ?? 200;
  return readability.wordCount > 0 ? (readability.wordCount / wpm) * 60000 : 0;
}

/* The language of the *text*, not of the browser.
 *
 * This used to fall back to `navigator.language`, so a French page carrying no
 * lang attribute was read as English on an en-US browser — and Flesch-Kincaid
 * then ran over it with a syllable counter that strips everything outside
 * [a-z], deleting the accents and scoring the prose far easier than it is.
 * `detectLanguage` prefers the document's own tag and sniffs the script only
 * when there is none. */
function pageLanguage() { return detectLanguage(document); }

// ── WPM baseline ───────────────────────────────────────────────────────────────
// Running median of standard-difficulty paragraph WPMs from this session.
// Seeded from chrome.storage on creation; updated continuously.
//
// Kept per language. A single global figure meant a reader's English 250 wpm
// was applied to their French and their Korean, and rates differ materially
// between languages — and between an English word and a segmented Chinese one,
// which are not the same unit at all. The registry below keeps one baseline
// per language and falls back to the legacy global value until a language has
// samples of its own.
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

/* One WpmBaseline per language, persisted as a map. `sra_baseline_wpm` (a bare
 * number) is left in place and used as the fallback for a language with no
 * samples yet, so existing installs keep the baseline they already earned and
 * nothing needs migrating. */
class WpmRegistry {
  constructor(fallback) {
    this._fallback = fallback || null;
    this._byLang   = new Map();
    this._saveTimer = null;
  }

  _for(lang) {
    const key = String(lang || 'en').slice(0, 2);
    if (!this._byLang.has(key)) this._byLang.set(key, new WpmBaseline(null));
    return this._byLang.get(key);
  }

  hydrate(fallback, map) {
    if (fallback) this._fallback = fallback;
    for (const [k, v] of Object.entries(map || {})) {
      if (v > 30 && v < 900) this._byLang.set(k, new WpmBaseline(v));
    }
  }

  get(lang) {
    const b = this._for(lang);
    return (b.hasSamples() ? b.get() : null) || b.get() || this._fallback;
  }

  hasSamples(lang) { return this._for(lang).hasSamples(); }

  add(lang, wpm, grade) {
    this._for(lang).add(wpm, grade);
    this._persist();
  }

  seedFromCalibration(wpm, lang) {
    this._fallback = wpm;
    this._for(lang || 'en').seedFromCalibration(wpm);
    this._persist();
  }

  /* Debounced: paragraph exits are frequent and each one would otherwise be a
     storage write. */
  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const out = {};
      for (const [k, b] of this._byLang) if (b.get()) out[k] = b.get();
      try { chrome.storage.local.set({ sra_baseline_wpm_by_lang: out }); } catch (e) { /* no storage */ }
    }, 2000);
  }
}

// ── Public factory ─────────────────────────────────────────────────────────────
export function createComprehensionMonitor(opts = {}) {
  const SPEED_RATIO_FAST   = opts.speedRatio     || 0.30;  // <30% of expected = too fast
  const SPEED_RATIO_SLOW   = 0.50;                          // <50% of personal baseline = too slow
  const MIN_WORD_COUNT     = opts.minWords        || 70;
  const MIN_DIFFICULTY     = opts.minDifficulty   || 58;    // FK score < 58 = dense enough to monitor
  const BACKTRACK_WINDOW   = opts.backtrackWindow || 4000;
  const COOLDOWN_MS        = opts.cooldown        || 30000;

  const Z_FAST = opts.zFast ?? -1.3;   // unusually quick for this reader
  const Z_SLOW = opts.zSlow ??  1.3;   // unusually slow for this reader

  let lastOfferAt    = 0;
  let paragraphEntry = null;
  let recentScrollY  = [];
  let lastScrollY    = window.scrollY;
  const residuals    = new ResidualDistribution(opts.minResiduals ?? 8);

  // Load persisted WPM baselines — the legacy global and the per-language map.
  const wpmBaseline = new WpmRegistry(null);
  try {
    chrome.storage.local.get({ sra_baseline_wpm: null, sra_baseline_wpm_by_lang: {} }, (r) => {
      wpmBaseline.hydrate(r.sra_baseline_wpm, r.sra_baseline_wpm_by_lang);
    });
  } catch (e) { /* no storage in tests */ }

  function enterParagraph(el) {
    if (!el) return;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text) return;
    const lang = pageLanguage();
    // Was `text.split(/\s+/).length`, which is 1 for a whole CJK paragraph, so
    // this returned early on every one of them and the monitor produced nothing.
    if (countWords(text, lang) < MIN_WORD_COUNT) return;
    const readability = analyzeDifficulty(text, { lang });
    /* Invariant 5: text-difficulty.js's structureIsUnreadable() case (a
     * script such as Thai or Khmer with no terminal punctuation, so the
     * whole paragraph parses as one "sentence") returns basis:
     * 'structure_unavailable' alongside a placeholder score: 60,
     * grade: 'standard' — a plausible-looking default standing in for a
     * measurement that was never taken. Leaving paragraphEntry unset here
     * means leaveParagraph()'s own `if (!paragraphEntry) return null;`
     * guard makes the whole paragraph a no-op: no expectedMs, no WPM
     * baseline sample, no residual, no speed_mismatch signal. The reader
     * gets `unknown` for this paragraph, and unknown never interrupts —
     * not a guess dressed up as a measurement. Backtrack and scroll
     * regression are untouched: neither reads paragraphEntry or difficulty
     * at all, so the extension keeps working, just without a pace signal
     * for text nothing could actually measure. */
    if (readability.basis === 'structure_unavailable') return;
    paragraphEntry = { el, text, lang, readability, enteredAt: Date.now() };
  }

  function leaveParagraph() {
    if (!paragraphEntry) return null;
    const entry    = paragraphEntry;
    paragraphEntry = null;
    const elapsed  = Date.now() - entry.enteredAt;
    const r        = entry.readability;

    const lang = entry.lang || 'en';

    // Always track WPM for baseline building (any language, any difficulty)
    if (elapsed > 1000 && r.wordCount > 0) {
      const wpm = Math.round((r.wordCount / elapsed) * 60000);
      wpmBaseline.add(lang, wpm, r.grade);
    }

    const expected = expectedReadingMs(r, wpmBaseline.get(lang));
    if (expected <= 0) return null;
    const ratio = elapsed / expected;

    // Record the residual before any early return, so the distribution keeps
    // learning during cooldowns and on paragraphs that trigger nothing.
    residuals.add(ratio);

    if (Date.now() - lastOfferAt < COOLDOWN_MS) return null;

    // Once there is enough history, ask whether this paragraph was unusual for
    // this reader rather than comparing against a constant. Someone who always
    // reads at 0.6x the model is not struggling on every paragraph.
    const z = residuals.zScore(ratio);
    const unusuallyFast = z != null ? z <= Z_FAST : ratio < SPEED_RATIO_FAST;
    const unusuallySlow = z != null ? z >= Z_SLOW : null;

    // Too fast through difficult text
    if (r.score < MIN_DIFFICULTY && unusuallyFast && r.wordCount >= MIN_WORD_COUNT) {
      return {
        type: 'speed_mismatch', subtype: 'too_fast',
        el: entry.el, text: entry.text, readability: r,
        ratio, elapsed, expected, z,
      };
    }

    // Too slow compared to personal baseline (silent struggle)
    if (wpmBaseline.hasSamples(lang) && elapsed > 3000 && r.wordCount >= 40) {
      const baseWpm     = wpmBaseline.get(lang);
      const actualWpm   = (r.wordCount / elapsed) * 60000;
      const slowRatio   = actualWpm / baseWpm;
      const isSlow      = unusuallySlow != null ? unusuallySlow : slowRatio < SPEED_RATIO_SLOW;
      if (isSlow && r.grade !== 'very_difficult') {
        return {
          type: 'speed_mismatch', subtype: 'too_slow',
          el: entry.el, text: entry.text, readability: r,
          ratio: slowRatio, actualWpm: Math.round(actualWpm), baselineWpm: baseWpm, z,
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

  /* Discard the in-flight paragraph without scoring it as a departure — used
   * on a genuine SPA route change. leaveParagraph() would otherwise compute
   * elapsed time against `enteredAt` from a paragraph that no longer exists
   * on screen; the WPM/residual samples that comes from would still be
   * numerically real (the reader did spend that time reading), but the
   * expected-time comparison it feeds is bound to text that is gone, so the
   * safer choice is silence rather than a sample that cannot be reproduced
   * or checked (invariant 5's instinct applied to a case its own text never
   * anticipated). */
  function resetParagraph() { paragraphEntry = null; }

  /* The calibration passages are English, so that is the language the measured
     figure belongs to. It still serves as the fallback everywhere else until
     each language earns its own samples. */
  function seedWpmFromCalibration(wpm, lang) { wpmBaseline.seedFromCalibration(wpm, lang || 'en'); }

  // How long the paragraph currently being read should take, and when the
  // reader arrived at it. The state engine needs both to tell "still reading"
  // apart from "stopped", which is the one question it asks the camera.
  function getCurrentExpectation() {
    if (!paragraphEntry) return null;
    return {
      expectedMs: expectedReadingMs(paragraphEntry.readability, wpmBaseline.get(paragraphEntry.lang)),
      enteredAt:  paragraphEntry.enteredAt,
    };
  }

  return {
    enterParagraph, leaveParagraph, onScroll, markOfferShown, resetParagraph,
    seedWpmFromCalibration, fleschKincaid, getCurrentExpectation,
    getBaselineWpm: () => wpmBaseline.get(),
    getResidualStats: () => residuals.stats(),
  };
}
