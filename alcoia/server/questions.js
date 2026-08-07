/* questions.js — retrieval questions from a passage
 *
 * Questions, not summaries, are the primary intervention. A summary removes
 * the desirable difficulty that produces retention; a question that the reader
 * has to answer is the only thing in this system that produces ground truth
 * about whether they understood anything.
 *
 * No express here on purpose — this is the part worth testing, and it should
 * be testable without standing a server up.
 *
 * The hard requirement is `span`. Every question must cite the sentence in the
 * passage that contains its answer, verbatim. A model that cannot point at its
 * evidence has invented the question, and an invented question asked of a
 * struggling reader is worse than no question at all. Spans that do not appear
 * in the passage are rejected rather than repaired.
 */

'use strict';

const MAX_PASSAGE_CHARS = 4000;

/* Normalise whitespace so a span that differs only in line wrapping still
 * matches. Anything beyond that is a real mismatch and should fail. */
function normalise(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* Stable content hash for the cache. Not cryptographic — it only has to make
 * collisions between different passages implausible. FNV-1a, 32-bit, rendered
 * with the length appended so same-hash different-length text cannot collide. */
function contentHash(text, opts = {}) {
  const key = `${normalise(text)}|${opts.kind || 'recall'}|${opts.count || 2}|${opts.language || 'auto'}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${key.length}`;
}

function buildQuestionPrompt(text, opts = {}) {
  const count = clampCount(opts.count);
  const kind = opts.kind === 'inference' ? 'inference' : 'recall';
  const passage = normalise(text).slice(0, MAX_PASSAGE_CHARS);

  const kindLine = kind === 'inference'
    ? 'Each question must require the reader to connect two ideas that are both stated in the passage. Do not ask anything that needs knowledge from outside it.'
    : 'Each question must ask about something stated explicitly in the passage.';

  return `A reader has just read the passage below and appears to be struggling with it. Write ${count} multiple-choice question${count === 1 ? '' : 's'} that check whether they understood it.

${kindLine}

Rules, all mandatory:
- Base every question ONLY on the passage below. Never use outside knowledge.
- Exactly 4 options per question. Exactly one correct.
- Wrong options must be plausible to someone who skimmed — not absurd, not obviously wrong by length or specificity.
- "span" must be copied VERBATIM from the passage: the single sentence containing the answer. Do not paraphrase it, do not shorten it, do not add ellipses. If you cannot copy an exact sentence, do not write that question.
- "explanation" is one sentence saying why the correct option is correct.
- Write in the same language as the passage.
- Do not reference "the passage" or "the text" in the question wording. Ask about the subject matter directly.

Return ONLY a JSON array, no prose, no markdown fence:
[{"q":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"...","span":"..."}]

Passage:
${passage}`;
}

function clampCount(n) {
  const c = Number.isFinite(n) ? Math.floor(n) : 2;
  return Math.max(1, Math.min(5, c));
}

/* Pull the JSON array out of a model response that may be wrapped in prose or
 * a markdown fence. Returns null rather than throwing — a malformed response
 * is an expected outcome, not an exception. */
function extractJsonArray(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/* Validate hard. Every rejection here is a question that would otherwise have
 * been put in front of a reader who is already having a bad time. */
function validateQuestion(q, haystack) {
  if (!q || typeof q !== 'object') return null;

  const text = normalise(q.q);
  if (text.length < 8) return null;

  if (!Array.isArray(q.options) || q.options.length !== 4) return null;
  const options = q.options.map(normalise);
  if (options.some((o) => o.length === 0)) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return null;   // duplicate options

  const answerIndex = Number(q.answerIndex);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return null;

  // The citation requirement. A span that is not in the passage means the
  // model invented the evidence, and the question goes with it.
  const span = normalise(q.span);
  if (span.length < 10) return null;
  if (!haystack.includes(span)) return null;

  return {
    q: text,
    options,
    answerIndex,
    explanation: normalise(q.explanation) || '',
    span,
  };
}

/* raw: the model's response. passage: what it was given.
 * Returns the questions that survive validation — possibly none. */
function parseQuestions(raw, passage, opts = {}) {
  const arr = extractJsonArray(raw);
  if (!arr) return [];

  const haystack = normalise(passage);
  const out = [];
  const seen = new Set();

  for (const candidate of arr) {
    const q = validateQuestion(candidate, haystack);
    if (!q) continue;
    const key = q.q.toLowerCase();
    if (seen.has(key)) continue;      // the model repeating itself
    seen.add(key);
    out.push(q);
    if (out.length >= clampCount(opts.count)) break;
  }
  return out;
}

/* Cache keyed on content hash. Same paragraph, same questions, no repeat API
 * cost — and the reader gets the same question if they come back, which is
 * what you want for a retrieval check. */
function createQuestionCache(opts = {}) {
  const maxEntries = opts.maxEntries ?? 500;
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now || (() => Date.now());
  const map = new Map();

  function get(key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (now() - entry.at > ttlMs) { map.delete(key); return null; }
    // Refresh recency so the eviction below is LRU rather than insertion-order.
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, { value, at: now() });
    while (map.size > maxEntries) map.delete(map.keys().next().value);
  }

  return { get, set, size: () => map.size, clear: () => map.clear() };
}

module.exports = {
  MAX_PASSAGE_CHARS,
  contentHash,
  buildQuestionPrompt,
  extractJsonArray,
  validateQuestion,
  parseQuestions,
  createQuestionCache,
  clampCount,
  normalise,
};
