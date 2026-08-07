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

import {
  countWords, splitSentences as segSentences, countClauseMarks,
  structureIsUnreadable,
} from './segmentation.js';

const SUBORDINATORS = /\b(although|though|whereas|because|since|unless|while|whilst|despite|whether|which|whom|whose|wherein|thereby|insofar|notwithstanding)\b/gi;
const PASSIVE_HINT   = /\b(is|are|was|were|been|being|be)\s+\w+(ed|en)\b/gi;

/* Where "ordinary prose" sits, per script family: mean words per clause and
 * words per sentence. The single English pair (7 / 15) was applied to every
 * language, and Arabic and CJK sentences are structurally longer, so both were
 * pushed toward very_difficult on almost every paragraph.
 *
 * These numbers are rough and unvalidated — the same caveat as everything else
 * in this file. They exist to remove a systematic bias, not to measure
 * anything. The per-reader residual distribution is what actually calibrates
 * pace; this only has to stop the difficulty grade from being wrong in one
 * direction for a whole language. */
const STRUCTURE_ANCHORS = {
  default: { clause: 7,  sentence: 15 },
  ar:      { clause: 10, sentence: 24 },
  fa:      { clause: 10, sentence: 24 },
  ur:      { clause: 10, sentence: 24 },
  he:      { clause: 8,  sentence: 18 },
  zh:      { clause: 9,  sentence: 22 },
  ja:      { clause: 10, sentence: 24 },
  ko:      { clause: 8,  sentence: 17 },
  de:      { clause: 8,  sentence: 18 },
  ru:      { clause: 8,  sentence: 18 },
};

function anchorsFor(lang) {
  return STRUCTURE_ANCHORS[String(lang || '').slice(0, 2)] || STRUCTURE_ANCHORS.default;
}

export function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

/* Both of these used to be whitespace and ASCII-punctuation regexes. See
 * telemetry/segmentation.js for why that produced a word count of ~1 for an
 * entire Chinese paragraph, and no sentence boundaries at all in Arabic. */
function splitSentences(text, lang) {
  return segSentences(text, lang);
}

function wordsIn(text, lang) {
  return countWords(text, lang);
}

/* English only. The syllable counter strips everything outside [a-z], so on
 * accented Latin it silently deletes letters and undercounts. `analyzeDifficulty`
 * is what guarantees this is never reached for other languages. */
export function fleschKincaid(text) {
  const sentences = splitSentences(text, 'en');
  const words     = text.split(/\s+/).filter((w) => w.trim().length > 0);
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
export function syntacticLoad(text, lang) {
  const sentences = splitSentences(text, lang);
  const wordCount = wordsIn(text, lang);
  if (!sentences.length || !wordCount) {
    return { score: 60, wordCount: 0, meanClauseLength: 0, wps: 0, commaDensity: 0, subordinators: 0 };
  }

  const commas   = countClauseMarks(text);
  const subs     = (text.match(SUBORDINATORS) || []).length;
  const passives = (text.match(PASSIVE_HINT) || []).length;

  /* Thai and Khmer mark phrase breaks with spaces and have no terminal
   * punctuation, so a paragraph is legitimately one "sentence". Scoring that
   * as a single enormous clause reads as maximally dense text, which is the
   * opposite of what it means. Say structure is unavailable instead. */
  if (structureIsUnreadable(sentences, wordCount)) {
    return {
      score: 60, wordCount, meanClauseLength: 0, wps: 0,
      commaDensity: commas / Math.max(1, sentences.length),
      subordinators: subs, passives, structureAvailable: false,
    };
  }

  const anchors          = anchorsFor(lang);
  const clauses          = Math.max(sentences.length, sentences.length + commas);
  const meanClauseLength = wordCount / clauses;
  const wps              = wordCount / sentences.length;

  const raw = 100
    - (meanClauseLength - anchors.clause) * 3.5
    - (wps - anchors.sentence) * 0.8
    - (subs / sentences.length) * 6
    - (passives / sentences.length) * 4;

  return {
    score: clamp(raw),
    wordCount,
    meanClauseLength,
    wps,
    commaDensity: commas / sentences.length,
    subordinators: subs,
    passives,
    structureAvailable: true,
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
  const lang = opts.lang || (opts.isEnglish === false ? 'xx' : 'en');
  const isEnglish = opts.isEnglish !== undefined
    ? opts.isEnglish !== false
    : String(lang).slice(0, 2) === 'en';
  const syn = syntacticLoad(text, lang);

  if (!isEnglish) {
    return {
      score: syn.score,
      grade: gradeFor(syn.score),
      wordCount: syn.wordCount,
      wps: syn.wps,
      syntactic: syn,
      lang,
      basis: syn.structureAvailable === false ? 'structure_unavailable' : 'syntactic',
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
    lang,
    basis: 'flesch_kincaid+syntactic',
  };
}
