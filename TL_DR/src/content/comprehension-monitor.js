/* comprehension-monitor.js
   Detects readers who appear focused but may not be understanding the content.
   Two independent signals feed into this:

   Signal 1 — Complexity vs speed mismatch
   We compute a readability score for each paragraph the user passes through.
   We then compare how long they actually spent on it against the expected
   minimum reading time for that complexity level. If they read a genuinely
   difficult paragraph too fast to have processed it, that is a risk.

   Signal 2 — Scroll backtrack
   If the user scrolls down past a paragraph and then scrolls back up to it
   within BACKTRACK_WINDOW_MS, they felt something was missed. We treat this
   as a soft confusion signal even when gaze patterns say focused.

   Both signals produce a "comprehension offer" — a small, non-intrusive popup
   that offers a summary but does not force one. The user can dismiss it.
   This is intentionally gentler than the gaze-triggered popup because the
   user appeared to be reading fine — we don't want to interrupt a reader who
   actually did understand.
*/

// ── Readability ────────────────────────────────────────────────────────────────
// Flesch-Kincaid Reading Ease (adapted for in-browser use without a syllable dict)
// Score: 90-100 = very easy, 60-70 = standard, 30-50 = difficult, 0-30 = very difficult
// We use syllable estimation (vowel-group counting) rather than a lookup table.

function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

function fleschKincaid(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words     = text.split(/\s+/).filter(w => w.trim().length > 0);
  if (sentences.length === 0 || words.length === 0) return { score: 60, grade: 'standard', wps: 0, spw: 0 };

  const totalSyllables = words.reduce((acc, w) => acc + countSyllables(w), 0);
  const wps  = words.length / sentences.length;       // words per sentence
  const spw  = totalSyllables / words.length;         // syllables per word
  const score = 206.835 - (1.015 * wps) - (84.6 * spw);

  let grade;
  if (score >= 80)      grade = 'easy';
  else if (score >= 60) grade = 'standard';
  else if (score >= 40) grade = 'difficult';
  else                  grade = 'very_difficult';

  return { score: Math.max(0, Math.min(100, score)), grade, wps, spw, wordCount: words.length };
}

// ── Expected reading time ──────────────────────────────────────────────────────
// Average adult reads 200-250 wpm for standard text.
// Difficult text requires 30-50% more time for comprehension.
// We use these multipliers to compute the minimum credible reading time.
const SPEED_WPM = {
  easy:           250,
  standard:       220,
  difficult:      160,
  very_difficult: 110,
};

function expectedReadingMs(readability) {
  const wpm = SPEED_WPM[readability.grade] || 200;
  return (readability.wordCount / wpm) * 60 * 1000;
}

// ── Paragraph tracker ──────────────────────────────────────────────────────────
// Only run FK formula on English pages — it produces meaningless scores otherwise
function isEnglishPage() {
  const lang = (
    document.documentElement.lang ||
    document.querySelector('meta[http-equiv="content-language"]')?.content ||
    navigator.language || 'en'
  ).toLowerCase().slice(0, 2);
  return lang === 'en' || lang === '';
}

export function createComprehensionMonitor(opts = {}) {
  const SPEED_RATIO_THRESHOLD = opts.speedRatio     || 0.55; // below 55% of expected time = too fast
  const MIN_WORD_COUNT        = opts.minWords        || 40;   // ignore very short paragraphs
  const MIN_DIFFICULTY        = opts.minDifficulty   || 40;   // only care about difficult text (FK score < 40)
  const BACKTRACK_WINDOW_MS   = opts.backtrackWindow || 6000; // scroll back within 6s = backtrack
  const COOLDOWN_MS           = opts.cooldown        || 15000;// min 15s between offers

  let lastOfferAt      = 0;
  let paragraphEntry   = null;  // { el, text, readability, enteredAt }
  let recentScrollY    = [];    // ring buffer of {y, t} for backtrack detection
  let lastScrollY      = window.scrollY;

  // Called when gaze settles on a new paragraph element
  function enterParagraph(el) {
    if (!el) return;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.split(/\s+/).length < MIN_WORD_COUNT) return;

    const readability = fleschKincaid(text);
    paragraphEntry = { el, text, readability, enteredAt: Date.now() };
  }

  // Called when gaze moves away from the current paragraph (or scroll moves past it)
  function leaveParagraph() {
    if (!paragraphEntry) return null;
    const entry    = paragraphEntry;
    paragraphEntry = null;

    const elapsed  = Date.now() - entry.enteredAt;
    const expected = expectedReadingMs(entry.readability);
    const ratio    = elapsed / expected;

    // Only flag genuinely difficult text that was read suspiciously fast
    if (!isEnglishPage())                          return null; // FK formula not valid for this language
    if (entry.readability.score > MIN_DIFFICULTY)  return null; // not difficult enough
    if (ratio >= SPEED_RATIO_THRESHOLD)            return null; // read at acceptable speed
    if (Date.now() - lastOfferAt < COOLDOWN_MS)    return null; // too soon after last offer

    return {
      type:        'speed_mismatch',
      el:          entry.el,
      text:        entry.text,
      readability: entry.readability,
      ratio:       ratio,
      elapsed:     elapsed,
      expected:    expected,
    };
  }

  // Called on every scroll event
  function onScroll() {
    const now      = Date.now();
    const currentY = window.scrollY;
    const delta    = currentY - lastScrollY;
    lastScrollY    = currentY;

    // Record position history
    recentScrollY.push({ y: currentY, t: now });
    // Keep only last 8 seconds
    recentScrollY = recentScrollY.filter(p => now - p.t < 8000);

    // Backtrack detection: user scrolled down recently, now scrolling back up significantly
    if (delta < -80 && recentScrollY.length > 3) {
      const windowStart = now - BACKTRACK_WINDOW_MS;
      const recentDown  = recentScrollY.filter(p => p.t > windowStart);
      if (recentDown.length > 0) {
        const maxY = Math.max(...recentDown.map(p => p.y));
        const backtrackAmount = maxY - currentY;
        if (backtrackAmount > 150 && Date.now() - lastOfferAt > COOLDOWN_MS) {
          return { type: 'backtrack', backtrackPx: backtrackAmount };
        }
      }
    }
    return null;
  }

  function markOfferShown() {
    lastOfferAt = Date.now();
  }

  return { enterParagraph, leaveParagraph, onScroll, markOfferShown, fleschKincaid };
}