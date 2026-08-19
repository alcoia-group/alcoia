/* tests/contract/questions.js — VENDORED SNAPSHOT, not shipped source.
 *
 * The API server moved to a separate private repo (see the project notes, "Migration
 * in progress"). This file is a copy of its pure, dependency-free question
 * logic, kept here only so the client's assumptions about the server's
 * contract — most importantly, that every question's `span` must appear
 * verbatim in the passage or be rejected — stay under test in this repo
 * rather than disappearing silently. Do not import this from shipped code;
 * the client never authors questions, it only consumes them. If this drifts
 * from the server repo's real copy, that is expected — update it by hand
 * when the contract changes, the same way any other fixture is updated.
 *
 * Original header, preserved for context:
 *
 * Questions, not summaries, are the primary intervention. A summary removes
 * the desirable difficulty that produces retention; a question that the reader
 * has to answer is the only thing in this system that produces ground truth
 * about whether they understood anything.
 *
 * The hard requirement is `span`. Every question must cite the sentence in the
 * passage that contains its answer, verbatim. A model that cannot point at its
 * evidence has invented the question, and an invented question asked of a
 * struggling reader is worse than no question at all. Spans that do not appear
 * in the passage are rejected rather than repaired.
 *
 * Item 42 — level-dependent span validation, added on top of the original
 * header above without weakening anything it promises. Scenario and
 * adversarial questions have answers that are NOT in the passage, by
 * construction — under the original rule alone they could never exist. The
 * span requirement itself does not move: verbatim, present in the passage,
 * mandatory, at every level, no exceptions. What changes is what the span is
 * required to anchor to — see SPAN_ROLE_FOR_LEVEL below. A model that cannot
 * point at real passage text is still rejected at every level; a question
 * whose answer lies outside the passage becomes possible only because the
 * thing it is anchored to lies inside it.
 */

'use strict';

const MAX_PASSAGE_CHARS = 4000;

// The four rungs of the difficulty ladder. Never extended beyond these four
// here — a fifth level is a decision for whoever owns the ladder (item 44),
// not something this file grows on its own.
const LEVELS = ['recognition', 'free_recall', 'scenario', 'adversarial'];

// What the span is required to anchor to, per level. Deterministic and never
// read from the model's own output — level is supplied by the caller (the
// client decides it, per item 44; the model is never asked to choose), and
// this mapping is the one place that decides what a valid span looks like
// for it. recognition/free_recall keep the original rule unchanged: the span
// is the sentence containing the answer. scenario and adversarial anchor to
// a principle or a claim instead, which is what lets their answers legally
// live outside the passage without the span requirement bending at all.
const SPAN_ROLE_FOR_LEVEL = {
  recognition: 'answer',
  free_recall: 'answer',
  scenario: 'principle',
  adversarial: 'claim',
};

// Unknown or missing level falls back to 'recognition' — the shape every
// caller before item 42 already assumed, so a caller that never heard of
// levels keeps getting exactly what it always got.
function normaliseLevel(level) {
  return LEVELS.includes(level) ? level : 'recognition';
}

/* Normalise whitespace so a span that differs only in line wrapping still
 * matches. Anything beyond that is a real mismatch and should fail. */
function normalise(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* Stable content hash for the cache. Not cryptographic — it only has to make
 * collisions between different passages implausible. FNV-1a, 32-bit, rendered
 * with the length appended so same-hash different-length text cannot collide.
 * `level` is part of the key — a scenario question and a recognition question
 * on the same passage are not interchangeable, and must not collide in the
 * cache into whichever one got written there first. */
function contentHash(text, opts = {}) {
  const key = `${normalise(text)}|${opts.kind || 'recall'}|${opts.count || 2}|${opts.language || 'auto'}|${normaliseLevel(opts.level)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${key.length}`;
}

/* One level per call — the caller (item 44's epistemic engine, client-side)
 * decides which of the four to ask for; this function never asks the model
 * to choose, and the model is never given the other three levels' framing to
 * pick from. Each branch below both explains what kind of question to write
 * AND pins down "span_role" in the returned-JSON example, so the model's own
 * declared span_role can be checked against what the requested level
 * actually requires (validateQuestion below rejects on any disagreement).
 * recognition and free_recall share one branch — item 42 only changes span
 * anchoring, and both already anchor to the answer exactly as before this
 * item; the format difference between them (item 43's concern, not this
 * one's) is not something this function has an opinion about yet. */
function buildQuestionPrompt(text, opts = {}) {
  const count = clampCount(opts.count);
  const kind = opts.kind === 'inference' ? 'inference' : 'recall';
  const level = normaliseLevel(opts.level);
  const passage = normalise(text).slice(0, MAX_PASSAGE_CHARS);
  const plural = count === 1 ? '' : 's';

  if (level === 'scenario') {
    return `A reader has just read the passage below. Write ${count} multiple-choice question${plural} that test whether they can APPLY a principle the passage states to a new situation the passage does not describe.

Rules, all mandatory:
- Each question must describe a short, concrete situation that is NOT in the passage, then ask the reader to apply a principle the passage actually states to that situation.
- The correct option must follow from applying the principle to the new situation. It must NOT be a fact stated anywhere in the passage — if the correct answer is already in the passage, this is the wrong kind of question.
- Exactly 4 options per question. Exactly one correct.
- Wrong options must be plausible to someone who understood the principle but misapplied it — not absurd, not obviously wrong by length or specificity.
- "span" must be copied VERBATIM from the passage: the single sentence stating the PRINCIPLE the question applies. Do not paraphrase it, do not shorten it, do not add ellipses. If you cannot copy an exact sentence stating a principle, do not write that question.
- "span_role" must be exactly "principle".
- "explanation" is one sentence saying why the correct option follows from the principle.
- Write in the same language as the passage.
- Do not reference "the passage" or "the text" in the question wording. Ask about the subject matter directly.

Return ONLY a JSON array, no prose, no markdown fence:
[{"q":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"...","span":"...","span_role":"principle"}]

Passage:
${passage}`;
  }

  if (level === 'adversarial') {
    return `A reader has just read the passage below. Write ${count} multiple-choice question${plural} that CHALLENGE a claim the passage makes, testing whether the reader's understanding holds up under scrutiny rather than just repeating the claim back.

Rules, all mandatory:
- Each question must pose a counterexample, edge case, or complicating detail to a claim the passage makes, and ask the reader to reason about whether the claim still holds.
- The correct option must require reasoning about the challenge. It must NOT be a fact stated anywhere in the passage — if the correct answer is already in the passage, this is the wrong kind of question.
- Exactly 4 options per question. Exactly one correct.
- Wrong options must be plausible to someone who only skimmed the challenge — not absurd, not obviously wrong by length or specificity.
- "span" must be copied VERBATIM from the passage: the single sentence stating the CLAIM the question challenges. Do not paraphrase it, do not shorten it, do not add ellipses. If you cannot copy an exact sentence stating a claim, do not write that question.
- "span_role" must be exactly "claim".
- "explanation" is one sentence saying why the correct option is correct under the challenge.
- Write in the same language as the passage.
- Do not reference "the passage" or "the text" in the question wording. Ask about the subject matter directly.

Return ONLY a JSON array, no prose, no markdown fence:
[{"q":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"...","span":"...","span_role":"claim"}]

Passage:
${passage}`;
  }

  // recognition / free_recall — the same prompt this function produced
  // before item 42, with only the two new span_role lines added (the rule
  // bullet and the JSON example field), since both levels keep the original
  // anchor rule: span = the sentence containing the answer.
  const kindLine = kind === 'inference'
    ? 'Each question must require the reader to connect two ideas that are both stated in the passage. Do not ask anything that needs knowledge from outside it.'
    : 'Each question must ask about something stated explicitly in the passage.';

  return `A reader has just read the passage below and appears to be struggling with it. Write ${count} multiple-choice question${plural} that check whether they understood it.

${kindLine}

Rules, all mandatory:
- Base every question ONLY on the passage below. Never use outside knowledge.
- Exactly 4 options per question. Exactly one correct.
- Wrong options must be plausible to someone who skimmed — not absurd, not obviously wrong by length or specificity.
- "span" must be copied VERBATIM from the passage: the single sentence containing the answer. Do not paraphrase it, do not shorten it, do not add ellipses. If you cannot copy an exact sentence, do not write that question.
- "span_role" must be exactly "answer".
- "explanation" is one sentence saying why the correct option is correct.
- Write in the same language as the passage.
- Do not reference "the passage" or "the text" in the question wording. Ask about the subject matter directly.

Return ONLY a JSON array, no prose, no markdown fence:
[{"q":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"...","span":"...","span_role":"answer"}]

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
 * been put in front of a reader who is already having a bad time.
 *
 * `level` is supplied by the caller — never read from `q` itself (item 42:
 * the model does not get to select its own level). It decides the one thing
 * that changes across the ladder: what `span` is required to anchor to. The
 * span check immediately below is otherwise completely unaware of level —
 * verbatim-in-the-passage is checked identically for all four, no exception,
 * no fuzzy match, no normalisation beyond normalise()'s existing whitespace
 * collapse. */
function validateQuestion(q, haystack, level) {
  if (!q || typeof q !== 'object') return null;
  const lvl = normaliseLevel(level);

  const text = normalise(q.q);
  if (text.length < 8) return null;

  if (!Array.isArray(q.options) || q.options.length !== 4) return null;
  const options = q.options.map(normalise);
  if (options.some((o) => o.length === 0)) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return null;   // duplicate options

  const answerIndex = Number(q.answerIndex);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return null;

  // The citation requirement. A span that is not in the passage means the
  // model invented the evidence, and the question goes with it. Unconditional
  // on level — this is what stays load-bearing while the thing it anchors to
  // changes below.
  const span = normalise(q.span);
  if (span.length < 10) return null;
  if (!haystack.includes(span)) return null;

  // Item 42: what the span is required to anchor to, for the level the
  // caller requested. `q.span_role` is the model's own declaration of what
  // its span is; disagreement with what the level actually requires is
  // rejected outright, exact string match only — this is the check that
  // stops a model citing an answer-sentence (the easy, familiar shape) for a
  // scenario question that required a principle-sentence instead.
  const requiredRole = SPAN_ROLE_FOR_LEVEL[lvl];
  if (q.span_role !== requiredRole) return null;

  return {
    q: text,
    options,
    answerIndex,
    explanation: normalise(q.explanation) || '',
    span,
    level: lvl,
    span_role: requiredRole,
  };
}

/* raw: the model's response. passage: what it was given. opts.level: which
 * of the four rungs this batch was generated for — one level per call (item
 * 44 picks it; this function does not).
 * Returns the questions that survive validation — possibly none. */
function parseQuestions(raw, passage, opts = {}) {
  const arr = extractJsonArray(raw);
  if (!arr) return [];

  const haystack = normalise(passage);
  const level = normaliseLevel(opts.level);
  const out = [];
  const seen = new Set();

  for (const candidate of arr) {
    const q = validateQuestion(candidate, haystack, level);
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
  LEVELS,
  SPAN_ROLE_FOR_LEVEL,
  contentHash,
  buildQuestionPrompt,
  extractJsonArray,
  validateQuestion,
  parseQuestions,
  createQuestionCache,
  clampCount,
  normalise,
};
