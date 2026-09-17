/* selection-explain.js — on-demand explanation for content retrieval
 * practice can't reach: equations, figure references, unfamiliar technical
 * terms (this item's own brief).
 *
 * Not a signals/ detector, the same reasoning scroll-kinematics-tracker.js's
 * own header gives: this asserts nothing about comprehension and feeds
 * nothing into state-engine.js, so the update()/signal() contract and
 * state-engine.js registration (CLAUDE.md §10) do not apply. It lives
 * directly under src/content/, same as session-tracker.js.
 *
 * Reader responses are still this product's only ground truth (CLAUDE.md
 * §1) — nothing here decides comprehension or spends the interruption
 * budget. This only decides whether a SELECTION looks like the specific
 * kind of content retrieval practice cannot help with (never encoded in
 * the first place), and if so, offers a quieter way to ask about it.
 *
 * Deliberately narrower than the existing plain-selection summary path
 * (content.js's mouseup handler, MIN_SELECTION_CHARS=15, any selection —
 * see CLAUDE.md §11.3's own "plain select is a summary" note). This module
 * only classifies; content.js decides which path wins for a given
 * selection (this one takes priority when it matches — see content.js's
 * own comment at the call site).
 */

import { segmentWords, splitSentences } from './signals/segmentation.js';
import { COMMON_WORDS } from '../libs/wordfreq/common-words.js';

const CONTEXT_SENTENCES_EACH_SIDE = 2;

// A conservative, common subset of math/logic operators — not exhaustive
// Unicode math coverage, which would false-positive on far more than
// equations (arrows and comparison operators show up in ordinary prose
// too, hence the narrow list rather than a whole Unicode block).
const MATH_OPERATORS = /[∑∫∂∇≈≠±√∞≤≥∀∃∈∉⊂⊆∪∩]/;
// Superscript/subscript digits and letters (U+2070-U+209F) plus the three
// Latin-1 superscripts (², ³, ¹) — covers x², a_n-style notation typeset
// with real Unicode sub/superscripts, not underscore/caret ASCII fallbacks
// (those are indistinguishable from ordinary punctuation and would
// false-positive constantly).
const SUB_SUPERSCRIPT = /[⁰-₟²³¹]/;
// f(x) = ..., y(t) = ... — a single letter, parens with a short identifier
// inside, then an equals sign. Narrow on purpose: "compare(x) = " in a
// selected sentence of ordinary prose is a real (rare) false positive this
// accepts in exchange for not matching "the function of government" or
// similar English constructions that happen to contain "(" and "=" nowhere
// near each other.
const LATEX_LIKE = /\b[a-zA-Z]\s*\([a-zA-Z][a-zA-Z0-9,\s]{0,4}\)\s*=/;

const FIGURE_REF = /\b(fig(?:ure)?\.?)\s*\d*/i;
// \b after "eq." would never match — a literal "." and the space that
// follows it are both non-word characters, so there is no word boundary
// between them (confirmed by a real failing test, not assumed). The period
// itself already delimits "eq." distinctly enough; \b is only needed on
// the three alternatives that end in a letter, to keep "figurehead" from
// matching "figure".
const CAPTION_START = /^(figure\b|table\b|equation\b|eq\.)/i;
const CAPTION_MAX_CHARS = 100;

const TERM_MAX_WORDS = 3;

function isMathNotation(text) {
  return MATH_OPERATORS.test(text) || SUB_SUPERSCRIPT.test(text) || LATEX_LIKE.test(text);
}

function isFigureOrCaption(text) {
  if (text.length > CAPTION_MAX_CHARS) return false;
  return FIGURE_REF.test(text) || CAPTION_START.test(text);
}

/* English-only, same as text-difficulty.js's lexicalRarity() and for the
 * same reason: COMMON_WORDS is an English frequency list, and checking a
 * non-English word against it would misclassify nearly everything as rare
 * (that file's own header). Reuses the SAME word list rather than a second
 * one — not a call to lexicalRarity() itself, which computes a whole-
 * passage ratio; this needs a per-selection yes/no for 1-3 words instead,
 * so it applies the same COMMON_WORDS lookup directly. */
function isRareTechnicalTerm(text, lang) {
  if (String(lang || 'en').slice(0, 2) !== 'en') return false;
  const words = segmentWords(text, 'en').filter((w) => w.length > 0);
  if (words.length === 0 || words.length > TERM_MAX_WORDS) return false;
  return words.every((w) => !COMMON_WORDS.has(w.toLowerCase().replace(/[^a-z']/g, '')));
}

/* Returns { type, mode } for a selection worth offering explanation on, or
 * null. `mode` is the existing /api/summarize mode this trigger type
 * should use (fetchSummary's own parameter — see host.js) — chosen from
 * what alcoiaServer's summary-prompts.js already supports, confirmed by
 * reading that file directly, not assumed:
 *   figure/caption -> 'image_context' (close fit: expects a caption/
 *     description as input; content.js's findFigureCaption() below
 *     supplies that, never the bare "Figure 3" reference itself)
 *   term           -> 'define_word' (near-exact fit: "explain in that
 *     specific context... plain language... if jargon, one analogy")
 *   math           -> 'explain_more' (an HONEST INTERIM STAND-IN, not a
 *     real fit — no existing mode is written for equations, and forcing
 *     'define_word' or 'explain_code' would assume a wrong shape. Flagged
 *     in this item's own report: alcoiaServer needs a dedicated
 *     explain_equation mode; do not build that here.)
 */
export function classifySelection(text, lang) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  if (isMathNotation(trimmed)) return { type: 'math', mode: 'explain_more' };
  if (isFigureOrCaption(trimmed)) return { type: 'figure', mode: 'image_context' };
  if (isRareTechnicalTerm(trimmed, lang)) return { type: 'term', mode: 'define_word' };

  // Per this item's own brief: a normal sentence (its own example, "longer
  // than ~40 characters without the above markers") never triggers — not a
  // fourth branch, just the natural result of every check above already
  // returning null for ordinary prose at any length.
  return null;
}

/* Locates the real figure a bare reference ("Figure 3", "see Fig. 3")
 * points at, so the explanation call sends something with actual content
 * to explain rather than the three-word reference itself (which alone,
 * sent to image_context, describes nothing). Checks <figcaption> first,
 * then any element whose own text starts with the same "Figure N" marker
 * (a caption not wrapped in <figcaption>, the common case on ordinary web
 * pages that don't use semantic HTML). Returns the caption text, or null
 * if no match exists — callers fall back to the bare selection rather than
 * fabricate a caption that was never found. */
export function findFigureCaption(refText, doc = document) {
  const numMatch = refText.match(/\d+/);
  const num = numMatch ? numMatch[0] : null;
  if (!num) return null;

  const pattern = new RegExp(`\\b(fig(?:ure)?\\.?)\\s*${num}\\b`, 'i');

  for (const fc of doc.querySelectorAll('figcaption')) {
    const t = (fc.textContent || '').trim();
    if (t && pattern.test(t)) return t;
  }
  // Fallback: a short block of text (not a whole article) that starts with
  // the same marker — the common "Figure 3: ..." paragraph pattern on pages
  // without <figure>/<figcaption>.
  for (const el of doc.querySelectorAll('p, div, span, caption')) {
    const t = (el.textContent || '').trim();
    if (t && t.length < 400 && pattern.test(t.slice(0, 40))) return t;
  }
  return null;
}

/* This item's own brief asks for "±2 sentences" of surrounding context, not
 * the whole containing paragraph (fetchSummary's existing `context`
 * parameter, used elsewhere for the PREVIOUS paragraph — a different,
 * coarser grain than what's wanted here). Splits the selection's own
 * containing paragraph into sentences (segmentation.js's splitSentences,
 * the same real sentence-boundary logic text-difficulty.js already relies
 * on, not a naive '.' split) and returns up to two sentences on each side
 * of whichever sentence(s) contain the selected text. Returns '' — never
 * the selection itself — when the selection cannot be located inside its
 * own paragraph's sentence split (should not happen in practice, but
 * degrading to no context is honest; inventing a guess is not). */
export function extractSurroundingContext(paragraphText, selectedText, lang) {
  const sentences = splitSentences(paragraphText || '', lang);
  if (!sentences.length || !selectedText) return '';

  let firstIdx = -1, lastIdx = -1;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].includes(selectedText)) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx === -1) return '';

  const start = Math.max(0, firstIdx - CONTEXT_SENTENCES_EACH_SIDE);
  const end = Math.min(sentences.length - 1, lastIdx + CONTEXT_SENTENCES_EACH_SIDE);
  return sentences.slice(start, end + 1).join(' ').trim();
}

/* Session-scoped state: which selections already got an explanation (so the
 * tooltip does not re-offer the same one), and which PARAGRAPHS did (for
 * the passive prerequisite-gap flag — see host.js's submitOutcome call
 * sites). Both keyed the same way every other paragraph-identity check in
 * this codebase already is — text.slice(0, 80).trim() — matching
 * intervention-policy.js's paragraphKey() and handleAsk()'s own
 * paragraphKey, so a key produced here is comparable to one produced there
 * without a second convention to keep in sync. */
export function createSelectionExplainTracker() {
  const explainedSelections = new Set();
  const explainedParagraphs = new Set();

  function fingerprint(text) { return (text || '').slice(0, 80).trim(); }

  return {
    classify: classifySelection,
    wasExplained: (text) => explainedSelections.has(fingerprint(text)),
    markExplained: (text) => explainedSelections.add(fingerprint(text)),
    wasParagraphExplained: (paragraphKey) => !!paragraphKey && explainedParagraphs.has(paragraphKey),
    markParagraphExplained: (paragraphKey) => { if (paragraphKey) explainedParagraphs.add(paragraphKey); },
    reset() { explainedSelections.clear(); explainedParagraphs.clear(); },
  };
}
