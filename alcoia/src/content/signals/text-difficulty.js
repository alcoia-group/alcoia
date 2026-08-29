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
  structureIsUnreadable, segmentWords,
} from './segmentation.js';
import { COMMON_WORDS } from '../../libs/wordfreq/common-words.js';

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
 * signals/segmentation.js for why that produced a word count of ~1 for an
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

/* Item 13c: CLT's "intrinsic load" — element interactivity × prior
 * knowledge — is not a syntax question at all. A short, unsubordinated
 * sentence packed with unfamiliar terms ("Mitochondria mediate oxidative
 * phosphorylation.") reads as EASY on syntacticLoad() above — no
 * subordinators, one clause, few words — while genuinely taxing working
 * memory more than a longer, plainly-worded one. This is a NEW,
 * INDEPENDENT input, not a replacement: a passage can be syntactically
 * simple and lexically dense, or syntactically dense and lexically
 * ordinary, and both matter separately (analyzeDifficulty() below blends
 * both, never substitutes one for the other).
 *
 * English-only — COMMON_WORDS (src/libs/wordfreq/common-words.js) is an
 * English frequency list; there is no non-English equivalent bundled here
 * (see NOTICE.md for its provenance AND a licensing caveat still awaiting
 * human review — flagged there deliberately, not resolved). Looking up
 * non-English words against an English list would misclassify nearly
 * everything as "rare", which is worse than reporting nothing — the same
 * reasoning fleschKincaid() above already applies to itself. */
export function lexicalRarity(text, lang) {
  const isEnglish = String(lang || '').slice(0, 2) === 'en';
  if (!isEnglish) return { available: false, score: 60, rareRatio: 0, rareCount: 0, wordCount: 0 };

  const words = segmentWords(text, 'en')
    .map((w) => w.toLowerCase().replace(/[^a-z']/g, ''))
    .filter((w) => w.length > 0);
  if (!words.length) return { available: true, score: 60, rareRatio: 0, rareCount: 0, wordCount: 0 };

  const rareCount = words.filter((w) => !COMMON_WORDS.has(w)).length;
  const rareRatio = rareCount / words.length;
  // Ordinary prose still uses SOME words outside a 10,000-word list (proper
  // nouns, plurals/inflections the list stores only in base form) — this
  // is not validated against real reading, the same caveat as every score
  // in this file, only shaped to separate dense prose from ordinary prose,
  // not to measure anything precisely.
  const raw = 100 - Math.max(0, rareRatio - 0.08) * 260;

  return { available: true, score: clamp(raw), rareRatio, rareCount, wordCount: words.length };
}

/* Per-script anchors for propositionalDensity()'s non-English fallback —
 * mirrors STRUCTURE_ANCHORS above, same reasoning: a script's own
 * "ordinary" word length varies (CJK morphemes carry more meaning per
 * character than Latin letters, so the SAME absolute length means
 * something different per script), so the anchor removes a systematic
 * per-script bias rather than measuring anything precisely. Rough and
 * unvalidated, the same caveat as everything else here. */
const WORD_LENGTH_ANCHORS = {
  default: 4.7,
  zh: 1.6, ja: 1.8, ko: 2.3,
  ar: 4.2, fa: 4.2, ur: 4.2,
  he: 4.0,
  de: 5.8,
  ru: 5.3,
};
function wordLengthAnchorFor(lang) {
  return WORD_LENGTH_ANCHORS[String(lang || '').slice(0, 2)] ?? WORD_LENGTH_ANCHORS.default;
}

/* Item 13c: "roughly how many distinct propositions/ideas" a passage packs
 * in per sentence — not a real proposition count (that needs real parsing/
 * POS tagging, which this item deliberately does not add; "a simple
 * idea-density heuristic is sufficient"). Two bases, chosen by data
 * availability, not by language family:
 *   - English: rare/content words per sentence — a genuinely new idea is
 *     introduced by a content word, and content words are reliably rarer
 *     than function words in any frequency list, so this reuses
 *     lexicalRarity()'s own data rather than inventing a second measure.
 *   - Everything else: mean word length vs. the script's own anchor
 *     above — cruder (conflates morphological compounding with idea
 *     density, most visibly in German), but genuinely independent of
 *     syntacticLoad()'s clause/comma/subordinator structure, and — unlike
 *     lexicalRarity() — available for every language segmentWords()
 *     already handles. This is the concrete improvement to non-English
 *     scoring this item's own brief asks for: a second real input where
 *     there used to be exactly one (syntacticLoad() alone). */
export function propositionalDensity(text, lang) {
  const words = segmentWords(text, lang).filter((w) => w.length > 0);
  const sentences = splitSentences(text, lang);
  if (!words.length || !sentences.length) {
    return { score: 60, wordsPerSentence: 0, sentenceCount: 0, basis: 'unavailable' };
  }

  // "Per sentence" is exactly as dependent on reliable sentence-splitting
  // as syntacticLoad()'s own clause-counting is — a script with no
  // terminal punctuation (Thai, Khmer) parses as one enormous "sentence",
  // and wordsPerSentence/rarePerSentence over that whole paragraph is not
  // a meaningful per-sentence density, any more than treating it as one
  // giant clause was. Abstain the same way syntacticLoad() already does,
  // rather than reporting a number that looks measured but is not.
  if (structureIsUnreadable(sentences, words.length)) {
    return { score: 60, wordsPerSentence: 0, sentenceCount: sentences.length, basis: 'structure_unavailable' };
  }

  const wordsPerSentence = words.length / sentences.length;
  const isEnglish = String(lang || '').slice(0, 2) === 'en';

  if (isEnglish) {
    const rare = words
      .map((w) => w.toLowerCase().replace(/[^a-z']/g, ''))
      .filter((w) => w.length > 0 && !COMMON_WORDS.has(w)).length;
    const rarePerSentence = rare / sentences.length;
    const raw = 100 - rarePerSentence * 9;
    return { score: clamp(raw), wordsPerSentence, sentenceCount: sentences.length, rarePerSentence, basis: 'lexical' };
  }

  const meanWordLength = words.reduce((a, w) => a + w.length, 0) / words.length;
  const anchor = wordLengthAnchorFor(lang);
  const raw = 100 - (meanWordLength - anchor) * 14;
  return { score: clamp(raw), wordsPerSentence, sentenceCount: sentences.length, meanWordLength, anchor, basis: 'word_length' };
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
 * English keeps FK as the largest single share because it is at least
 * validated for English text. Item 13c adds lexicalRarity()/
 * propositionalDensity() as further, independent shares alongside it and
 * syntacticLoad() — never replacing either. `basis` stays exactly the
 * strings every existing consumer already checks
 * ('flesch_kincaid+syntactic' / 'syntactic' / 'structure_unavailable') —
 * the new signals change what `score` VALUES land on, not the shape or
 * the labels callers already branch on.
 *
 * Non-English previously ran on syntacticLoad() alone — the whole reason
 * those pages produced a difficulty signal at all, per the header above —
 * and now also gets propositionalDensity()'s word-length-based fallback
 * (segmentWords() already tokenizes every language; lexicalRarity() alone
 * cannot, since COMMON_WORDS is English-only). This is the concrete fix
 * for non-English scoring this item's own brief describes: a second real
 * input where there used to be exactly one. propositionalDensity() does
 * not depend on structureIsUnreadable()'s clause-counting at all (it never
 * counts commas or clauses), so it still contributes even for the
 * Thai/Khmer 'structure_unavailable' case, where syntacticLoad()'s own
 * score is pinned at a neutral 60. */
export function analyzeDifficulty(text, opts = {}) {
  const lang = opts.lang || (opts.isEnglish === false ? 'xx' : 'en');
  const isEnglish = opts.isEnglish !== undefined
    ? opts.isEnglish !== false
    : String(lang).slice(0, 2) === 'en';
  const syn  = syntacticLoad(text, lang);
  const prop = propositionalDensity(text, lang);

  if (!isEnglish) {
    const score = clamp(syn.score * 0.6 + prop.score * 0.4);
    return {
      score,
      grade: gradeFor(score),
      wordCount: syn.wordCount,
      wps: syn.wps,
      syntactic: syn,
      propositional: prop,
      lang,
      basis: syn.structureAvailable === false ? 'structure_unavailable' : 'syntactic',
    };
  }

  const fk  = fleschKincaid(text);
  const lex = lexicalRarity(text, lang);
  const score = clamp(fk.score * 0.4 + syn.score * 0.25 + lex.score * 0.20 + prop.score * 0.15);
  return {
    score,
    grade: gradeFor(score),
    wordCount: fk.wordCount,
    wps: fk.wps,
    spw: fk.spw,
    fleschScore: fk.score,
    syntactic: syn,
    lexical: lex,
    propositional: prop,
    lang,
    basis: 'flesch_kincaid+syntactic',
  };
}
