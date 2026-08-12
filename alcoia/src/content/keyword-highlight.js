/* keyword-highlight.js — load-bearing terms in a post-failure explanation
 *
 * Only on the failure path: after a wrong answer, on the explanation text
 * itself. Never in the question, never in the options, never in the quoted
 * span (that is the passage, verbatim, and highlighting it would blur the
 * line between "the system's own emphasis" and "words already in the
 * source text") — the project notes' `--alc-sage` is reserved for moments the
 * system itself produced, and a correct answer never reaches this module
 * at all (see item 12: confirmation only, no explanation, no highlighting).
 *
 * Term selection is a client-side heuristic, not a server field. The
 * question/explanation contract (tests/contract/questions.js) has no
 * "key terms" field, and adding one would be a server change — out of
 * scope here. So this picks candidates itself: the longest, least common
 * words in the explanation, skipping short function words. It is a
 * heuristic, not linguistics — good enough to draw the eye to two or three
 * substantive words, not a claim about which words actually matter most.
 *
 * The regex only matches Latin-ish letters, so a CJK/Thai/etc. explanation
 * naturally yields no candidates and no highlighting — degrading to
 * nothing rather than guessing at word boundaries a naive regex cannot
 * find in an unspaced script (the same invariant-5 instinct as everywhere
 * else in this codebase: no signal beats a wrong one).
 *
 * Highlighting wraps matches in the ALREADY-ESCAPED HTML string — it never
 * interprets anything the model returned as markup. The only tags this
 * file ever introduces are its own literal `<span class="sra-term">`.
 */

const MIN_TERMS = 2;
const MAX_TERMS = 4;
const MIN_TERM_LENGTH = 4;

// Common English function words. Deliberately not exhaustive — missing one
// just means an occasional short connector gets highlighted alongside the
// real terms, not a wrong highlight.
const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'has', 'had',
  'will', 'would', 'could', 'should', 'about', 'into', 'onto', 'over',
  'under', 'after', 'before', 'while', 'because', 'since', 'than', 'then',
  'were', 'been', 'being', 'they', 'them', 'their', 'there', 'where',
  'when', 'what', 'which', 'who', 'whom', 'whose', 'your', 'yours',
  'also', 'only', 'just', 'more', 'most', 'some', 'such', 'each', 'every',
  'both', 'either', 'neither', 'itself', 'here', 'like',
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Returns 2-4 candidate words from `text`, or an empty array if fewer than
 * 2 qualify — a single highlighted word is not "emphasis with signal", per
 * the project notes' own reasoning against highlighting more than four. */
export function pickLoadBearingTerms(text) {
  if (!text) return [];
  const words = text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)?/g) || [];

  const seen = new Map(); // lowercase -> first-seen original casing
  for (const w of words) {
    if (w.length < MIN_TERM_LENGTH) continue;
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (!seen.has(lower)) seen.set(lower, w);
  }

  const ranked = [...seen.values()]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_TERMS);

  return ranked.length >= MIN_TERMS ? ranked : [];
}

/* `escapedHtml` must already be HTML-escaped (esc(text)) — this only ever
 * wraps whole-word matches in a literal <span>, never parses or trusts
 * anything in the string as markup. */
export function wrapTerms(escapedHtml, terms) {
  let result = escapedHtml;
  for (const term of terms) {
    const pattern = new RegExp(`\\b(${escapeRegExp(term)})\\b`, 'i');
    result = result.replace(pattern, '<span class="sra-term">$1</span>');
  }
  return result;
}

/* The one function callers actually need: escape, pick terms, wrap. Falls
 * back to plain escaped text when fewer than two terms qualify. */
export function renderHighlightedExplanation(text, esc) {
  const escaped = esc(text);
  const terms = pickLoadBearingTerms(text);
  return terms.length ? wrapTerms(escaped, terms) : escaped;
}
