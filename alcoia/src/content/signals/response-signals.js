/* response-signals.js — what the reader actually answered
 *
 * Top of the signal hierarchy, and the only ground truth in the system.
 * Everything else infers comprehension from behaviour; this observes it.
 * A wrong answer is not evidence that someone is probably struggling — it is
 * a reader failing to retrieve something they just read.
 *
 * So these outrank every other signal in the engine, and a correct answer
 * is as informative as a wrong one: it says the slow reading that triggered
 * the question was fine, and the system should stop pressing.
 *
 * The auxiliary measures — how long they took, whether they changed their
 * mind, whether they scrolled back to look — are recorded for the receipt.
 * None of them are used to override the answer itself.
 *
 * Item 43: grading authority now degrades by level. answer() below is
 * UNCHANGED — recognition stays deterministic, client-side, full tier-1
 * authority. Two more paths exist alongside it: answerGraded() for a
 * MODEL verdict (free_recall, scenario — the answer was sent to the server
 * for grading) and respond() for adversarial, which is never graded at all.
 * Every record now carries gradingMethod and level explicitly — see
 * state-engine.js's fromSignal(), which reads both to decide how much
 * confidence the record is allowed to carry. This file never computes that
 * confidence itself, on purpose: state-engine.js is the one place that
 * decides, so a model verdict cannot accidentally end up trusted as much as
 * a deterministic one just because whoever called this file supplied a
 * generous number. */

export const SLOW_ANSWER_MS = 20000;
// Defensive truncation only — the real gate against an oversized answer is
// host.js's fetchGrading(), which refuses to even attempt a grading call
// above this length (mirrors tests/contract/grading.js's MAX_ANSWER_CHARS).
// By the time a record reaches here the text should already be within
// bounds; this just stops one from growing without limit in the receipt.
const MAX_ANSWER_TEXT_CHARS = 500;
const GRADABLE_LEVELS = ['free_recall', 'scenario', 'adversarial'];

export function createResponseSignals(opts = {}) {
  const now = opts.now || (() => Date.now());
  const slowAnswerMs = opts.slowAnswerMs ?? SLOW_ANSWER_MS;

  let asked = null;
  let pending = null;
  const history = [];

  /* Call when the question card goes on screen. */
  function present(question, context = {}) {
    asked = {
      span: question?.span || null,
      level: GRADABLE_LEVELS.includes(question?.level) ? question.level : 'recognition',
      paragraphKey: context.paragraphKey || null,
      // Item S6/E4 follow-up. paragraphIndex is the active paragraph's
      // real ordinal (orchestrator.js's own paragraph-tracker index),
      // null whenever the caller has none — the session-recall review
      // path never does (see host.js's own header). questionId is
      // question-card.js's own popup-dedup fingerprint, reused as-is
      // rather than inventing a second identity for the same question:
      // there is no question id anywhere else in this system, since
      // questions are generated on the fly and never persisted server-
      // side. Both additive, both null-safe for every existing caller
      // that never sets them — ordinary (non-assignment) reading is
      // unaffected.
      paragraphIndex: Number.isInteger(context.paragraphIndex) ? context.paragraphIndex : null,
      questionId: typeof context.questionId === 'string' && context.questionId ? context.questionId : null,
      askedAt: now(),
      revisions: 0,
      scrolledBack: false,
      // Tags the resulting record only — never transmitted. See CLAUDE.md,
      // exploration sampling: labels not conditioned on the detector's own
      // decision are the point, so they must stay identifiable downstream.
      wasExplorationSample: context.wasExplorationSample === true,
    };
    return asked;
  }

  /* The reader changed their selection before committing. Recorded, not acted
   * on — hesitation is not the same as being wrong. */
  function revise() {
    if (asked) asked.revisions += 1;
  }

  /* They went back to the passage before answering, which is a legitimate
   * thing to do and is worth knowing when reading the receipt later. */
  function markScrollBack() {
    if (asked) asked.scrolledBack = true;
  }

  /* Call with the reader's answer. Produces the signal the engine consumes.
   *
   * `confidence` — 'low', 'high', or omitted/null — is captured at the same
   * moment as the answer, not probed afterward. A post-hoc "are you sure?"
   * leaks the result if it appears more often after wrong answers; capturing
   * it at commit time cannot leak, since it is asked identically regardless
   * of what the answer turns out to be (CLAUDE.md, confidence calibration).
   * Skippable — a reader who didn't rate it gets null here, not a forced
   * guess, and null must never be treated as either 'low' or 'high'. */
  function answer(chosenIndex, question, confidence) {
    if (!asked) return null;
    const correct = Number(chosenIndex) === Number(question?.answerIndex);
    const latencyMs = now() - asked.askedAt;
    const normalizedConfidence = confidence === 'low' || confidence === 'high' ? confidence : null;

    const record = {
      type: 'response',
      subtype: correct ? 'correct' : 'incorrect',
      correct,
      // Item 13j-1: which specific option — correct or incorrect — the
      // reader actually chose, confirmed by reading alcoiaServer's
      // src/outcomes/classify.js directly: it clusters wrong answers by
      // this exact value to distinguish a shared misconception from
      // scattered difficulty, comparing it for equality only, so a plain
      // option index (the same identifier question-card.js's own
      // data-index already uses) is a correct, sufficient identifier —
      // this file does not invent a second one. Only this function
      // (recognition, real discrete options) ever has one;
      // answerGraded()/respond() below are free-text levels with nothing
      // to record here, and simply never set this field at all — the
      // outcome-submission call site reads its absence as null, not
      // fabricated.
      chosenIndex: Number.isInteger(Number(chosenIndex)) ? Number(chosenIndex) : null,
      confidence: normalizedConfidence,
      // Item 43: explicit even though this path never changes — a record
      // that carries the method only sometimes would make state-engine.js's
      // `sig.gradingMethod === 'model'` check the ONLY thing distinguishing
      // "deterministic" from "just didn't say", which is worse than saying
      // so plainly.
      gradingMethod: 'deterministic',
      level: asked.level,
      latencyMs,
      slow: latencyMs > slowAnswerMs,
      revisions: asked.revisions,
      scrolledBack: asked.scrolledBack,
      span: asked.span,
      paragraphKey: asked.paragraphKey,
      paragraphIndex: asked.paragraphIndex,
      questionId: asked.questionId,
      wasExplorationSample: asked.wasExplorationSample,
    };

    history.push(record);
    pending = record;
    asked = null;
    return record;
  }

  /* Call with a MODEL-GRADED verdict — free_recall or scenario (item 43).
   * Unlike answer() above, grading happened server-side and arrives as a
   * verdict already decided, not an index for this file to compare.
   * `verdict` is 'correct' | 'incorrect' | 'unknown' (anything else
   * normalises to 'unknown' — the safe default, never a guess). 'unknown'
   * asserts nothing: state-engine.js's fromSignal() returns null for it,
   * the same as a dismissal, per invariants 5/9. This file does not decide
   * what confidence a model verdict carries — see this file's own header —
   * that stays entirely state-engine.js's call. */
  function answerGraded(answerText, verdict, confidence) {
    if (!asked) return null;
    const latencyMs = now() - asked.askedAt;
    const normalizedConfidence = confidence === 'low' || confidence === 'high' ? confidence : null;
    const normalizedVerdict = verdict === 'correct' || verdict === 'incorrect' ? verdict : 'unknown';

    const record = {
      type: 'response',
      subtype: normalizedVerdict,
      correct: normalizedVerdict === 'unknown' ? null : normalizedVerdict === 'correct',
      confidence: normalizedConfidence,
      gradingMethod: 'model',
      level: asked.level,
      answerText: String(answerText || '').slice(0, MAX_ANSWER_TEXT_CHARS),
      latencyMs,
      slow: latencyMs > slowAnswerMs,
      revisions: asked.revisions,
      scrolledBack: asked.scrolledBack,
      span: asked.span,
      paragraphKey: asked.paragraphKey,
      paragraphIndex: asked.paragraphIndex,
      questionId: asked.questionId,
      wasExplorationSample: asked.wasExplorationSample,
    };

    history.push(record);
    pending = record;
    asked = null;
    return record;
  }

  /* Call for an ADVERSARIAL answer (item 43) — never graded, by design. The
   * reader produced an argument; the value is that they produced it, not
   * whether a model agrees with it. Distinct from dismiss(): the reader DID
   * engage, so this is not a refusal — but it asserts nothing about
   * comprehension either. `correct` stays null and state-engine.js reads
   * this the same way it reads a dismissal or an unknown grading verdict:
   * nothing — UNCHANGED by the fix below.
   *
   * `confidence` — bug fix, found during the assignment-outcomes work:
   * question-card.js's confidence step runs for adversarial exactly as it
   * does for recognition/free_recall/scenario (the reader genuinely picks
   * one), but this function used to hardcode `confidence: null` regardless
   * of what they chose, silently discarding it before it ever reached
   * anywhere the signal is used — state-engine.js, the receipt, or (since
   * the assignment-outcomes item) the outcomes endpoint. Normalized the
   * same way answer()/answerGraded() already do, immediately above; this
   * does not touch `correct`/`gradingMethod`/`subtype` at all. */
  function respond(answerText, confidence) {
    if (!asked) return null;
    const latencyMs = now() - asked.askedAt;
    const normalizedConfidence = confidence === 'low' || confidence === 'high' ? confidence : null;

    const record = {
      type: 'response',
      subtype: 'ungraded',
      correct: null,
      confidence: normalizedConfidence,
      gradingMethod: 'none',
      level: asked.level,
      answerText: String(answerText || '').slice(0, MAX_ANSWER_TEXT_CHARS),
      latencyMs,
      slow: latencyMs > slowAnswerMs,
      revisions: asked.revisions,
      scrolledBack: asked.scrolledBack,
      span: asked.span,
      paragraphKey: asked.paragraphKey,
      paragraphIndex: asked.paragraphIndex,
      questionId: asked.questionId,
      wasExplorationSample: asked.wasExplorationSample,
    };

    history.push(record);
    pending = record;
    asked = null;
    return record;
  }

  /* The reader closed the card without answering. That is not a wrong answer
   * and must not be scored as one — it is a refusal to be tested, which is
   * their right, and the system should read it as "stop asking" rather than
   * as evidence of anything about their comprehension. */
  function dismiss() {
    if (!asked) return null;
    const record = {
      type: 'response',
      subtype: 'dismissed',
      correct: null,
      gradingMethod: 'none',
      level: asked.level,
      latencyMs: now() - asked.askedAt,
      span: asked.span,
      paragraphKey: asked.paragraphKey,
      wasExplorationSample: asked.wasExplorationSample,
    };
    history.push(record);
    pending = record;
    asked = null;
    return record;
  }

  function signal() { const s = pending; pending = null; return s; }

  function stats() {
    const answered = history.filter((h) => h.correct !== null);
    const correct = answered.filter((h) => h.correct).length;
    const latencies = answered.map((h) => h.latencyMs).sort((a, b) => a - b);
    return {
      asked: history.length,
      answered: answered.length,
      correct,
      dismissed: history.filter((h) => h.subtype === 'dismissed').length,
      medianLatencyMs: latencies.length
        ? latencies[Math.floor(latencies.length / 2)]
        : null,
    };
  }

  return {
    present, revise, markScrollBack, answer, answerGraded, respond, dismiss,
    signal, stats,
    isPending: () => asked !== null,
    history: () => history.slice(),
  };
}
