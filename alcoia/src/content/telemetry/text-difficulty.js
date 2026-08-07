/* text-difficulty.js — how hard a paragraph is to parse
 *
 * Flesch-Kincaid is a 1940s syllable-counting formula. It correlates with
 * difficulty but does not measure parsing cost, and it is English-only —
 * which left non-English pages with almost no primary signal, because
 * comprehension-monitor skipped every FK-based check on them.
 *
 * The syntactic measures here are proxies for how much structure the reader
 * has to hold at once: clause length, sentence length, subordination. They
 * need no syllable dictionary, so they work on any space-delimited language,
 * and they are what carries non-English pages.
 *
 * Nothing here is validated against real reading. It is a better-shaped
 * heuristic than a syllable count, not a measurement.
 */

const SUBORDINATORS = /\b(although|though|whereas|because|since|unless|while|whilst|despite|whether|which|whom|whose|wherein|thereby|insofar|notwithstanding)\b/gi;
const PASSIVE_HINT   = /\b(is|are|was|were|been|being|be)\s+\w+(ed|en)\b/gi;

export function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

function splitSentences(text) {
  return text.split(/[.!?。！？]+/).filter((s) => s.trim().length > 0);
}

function splitWords(text) {
  return text.split(/\s+/).filter((w) => w.trim().length > 0);
}

export function fleschKincaid(text) {
  const sentences = splitSentences(text);
  const words     = splitWords(text);
  if (!sentences.length || !words.length) return { score: 60, grade: 'standard', wordCount: 0 };

  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  const wps  = words.length / sentences.length;
  const spw  = syllables / words.length;
  const raw  = 206.835 - 1.015 * wps - 84.6 * spw;

  return { score: clamp(raw), grade: gradeFor(clamp(raw)), wps, spw, wordCount: words.length };
}

/* Structural load, on the same 0-100 scale as FK where higher means easier.
 * Clause count is approximated from terminal punctuation plus the internal
 * marks that usually introduce one. It is crude and it does not need to be
 * better — it only has to separate dense prose from ordinary prose. */
export function syntacticLoad(text) {
  const sentences = splitSentences(text);
  const words     = splitWords(text);
  if (!sentences.length || !words.length) {
    return { score: 60, wordCount: 0, meanClauseLength: 0, wps: 0, commaDensity: 0, subordinators: 0 };
  }

  const commas   = (text.match(/[,;:—–]/g) || []).length;
  const subs     = (text.match(SUBORDINATORS) || []).length;
  const passives = (text.match(PASSIVE_HINT) || []).length;

  const clauses          = Math.max(sentences.length, sentences.length + commas);
  const meanClauseLength = words.length / clauses;
  const wps              = words.length / sentences.length;

  // Anchored so ordinary prose lands near the middle of the scale: ~7 words
  // per clause and ~15 words per sentence read as unremarkable.
  const raw = 100
    - (meanClauseLength - 7) * 3.5
    - (wps - 15) * 0.8
    - (subs / sentences.length) * 6
    - (passives / sentences.length) * 4;

  return {
    score: clamp(raw),
    wordCount: words.length,
    meanClauseLength,
    wps,
    commaDensity: commas / sentences.length,
    subordinators: subs,
    passives,
  };
}

function clamp(n) { return Math.max(0, Math.min(100, n)); }

function gradeFor(score) {
  if (score >= 80) return 'easy';
  if (score >= 60) return 'standard';
  if (score >= 40) return 'difficult';
  return 'very_difficult';
}

/* The combined figure the rest of the system consumes.
 *
 * English keeps FK as the majority of the score because it is at least
 * validated for English text. Everything else runs on structure alone, which
 * is the whole point — those pages previously produced no difficulty signal at
 * all, so every reading-rate expectation on them fell back to a constant. */
export function analyzeDifficulty(text, opts = {}) {
  const isEnglish = opts.isEnglish !== false;
  const syn = syntacticLoad(text);

  if (!isEnglish) {
    return {
      score: syn.score,
      grade: gradeFor(syn.score),
      wordCount: syn.wordCount,
      wps: syn.wps,
      syntactic: syn,
      basis: 'syntactic',
    };
  }

  const fk = fleschKincaid(text);
  const score = clamp(fk.score * 0.6 + syn.score * 0.4);
  return {
    score,
    grade: gradeFor(score),
    wordCount: fk.wordCount,
    wps: fk.wps,
    spw: fk.spw,
    fleschScore: fk.score,
    syntactic: syn,
    basis: 'flesch_kincaid+syntactic',
  };
}
