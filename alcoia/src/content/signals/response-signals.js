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
  // Intelligence-architecture audit, step 5. Concurrency correctness: this
  // module has always tracked "the pending question" as a single `asked`
  // variable, which is correct only if at most one question can ever be
  // awaiting an answer at a time. That invariant does NOT actually hold —
  // confirmed by reading the real call sites, not assumed: host.js's
  // handleAsk (an orchestrator-triggered inline ask) and runSessionRecall
  // (a reader-initiated review) both render through the SAME questionCard
  // instance, and ui-controller.js's own MAX_POPUPS is 5, not 1 — a second
  // question can genuinely render while a first is still open and
  // unanswered (orchestrator.js's own interventionInFlight guard only
  // covers the async gap between a decision and a card actually reaching
  // the screen, not the whole time the card stays open waiting on the
  // reader). Before interventionId existed, answering the FIRST of two such
  // cards after the second had already rendered would silently do nothing
  // (`if (!asked) return null`, since the second present() had already
  // overwritten `asked`) — a real, pre-existing bug, only surfaced now
  // because step 5 needs unambiguous per-intervention attribution anyway.
  //
  // Fixed WITHOUT changing this module's existing public shape: `asked`
  // stays exactly as it was (every caller that never mentions an
  // interventionId — every test written before this item, and quiz.js's
  // own sequential, one-question-at-a-time UI, which has no concurrency
  // risk to fix) keeps working byte-for-byte as before, via `asked`.
  // Additionally, WHEN a caller supplies context.interventionId to
  // present(), that record is ALSO indexed here, keyed by id; a later
  // answer()/answerGraded()/respond()/dismiss()/revise()/markScrollBack()
  // call that supplies the SAME interventionId resolves THAT specific
  // record instead of `asked` — so two concurrently open cards, each
  // presented with their own interventionId, can now be answered in any
  // order without cross-contaminating or silently dropping either one.
  const pendingByIntervention = new Map();

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
      // Knowledge-unit identity (intelligence-architecture audit, step 3):
      // additive, null-safe, same shape as paragraphIndex/questionId above.
      // Computed by the caller (host.js/quiz.js, via knowledge-unit.js) from
      // the same text paragraphKey was already sliced from — this file
      // doesn't compute it itself, the same way it has never computed
      // paragraphKey itself. paragraphKey is UNCHANGED and still set above:
      // this is additive, not a replacement — see epistemic-engine.js's own
      // compatibility-layer comment for how the two now interact.
      knowledgeUnitId: typeof context.knowledgeUnitId === 'string' && context.knowledgeUnitId ? context.knowledgeUnitId : null,
      askedAt: now(),
      revisions: 0,
      scrolledBack: false,
      // Evidence-silo fix (intelligence-architecture audit, step 2): where a
      // record came from. Every existing caller (question-card.js, both from
      // the floating card and session-recall's review flow) is the in-page
      // card and never sets this, so the default is 'inline' — matching what
      // was already true of every record this module has ever produced.
      // quiz.js is the one caller that now passes 'quiz' explicitly, using
      // this exact same present()/answer()/answerGraded()/respond() flow
      // rather than hand-building a record — see quiz.js's own header.
      // pickLevelForConcept()/isSystematicallyOverconfident() (epistemic-
      // engine.js) do not read this field at all; it exists so a future
      // reader of history() can tell the two apart if it ever matters,
      // without merging the two sources into one undifferentiated pool.
      source: context.source === 'quiz' ? 'quiz' : 'inline',
      // Intelligence-architecture audit, step 5. Null-safe, additive, same
      // shape as knowledgeUnitId above — a caller that predates this field
      // (every existing test, quiz.js before this item) simply never sets
      // it, and `asked` alone still resolves every terminal call exactly as
      // before. See this factory's own top-of-closure comment for why a
      // second index is also needed.
      interventionId: typeof context.interventionId === 'string' && context.interventionId ? context.interventionId : null,
    };
    if (asked.interventionId) pendingByIntervention.set(asked.interventionId, asked);
    return asked;
  }

  /* Resolves which pending record a terminal call means: the one keyed by
   * `interventionId` when the caller supplies one and it is still pending,
   * otherwise the single shared `asked` slot — the original, unchanged
   * behaviour for every caller that doesn't know about interventionId at
   * all. Never falls back to `asked` when an interventionId WAS supplied
   * but doesn't (or no longer) resolve to anything — that would silently
   * resolve the wrong card's pending state under exactly the concurrency
   * this mechanism exists to prevent. */
  function resolvePending(interventionId) {
    if (interventionId) return pendingByIntervention.get(interventionId) || null;
    return asked;
  }

  /* Removes `target` from whichever tracking structure(s) hold it — the map
   * entry (if it came from one) and/or the shared `asked` slot (if `asked`
   * still happens to be this exact record, the common single-intervention
   * case). Deliberately checks `asked === target` by reference rather than
   * unconditionally nulling `asked` — the whole point of this fix is that
   * resolving ONE pending intervention must never clobber a DIFFERENT one
   * still sitting in `asked`. */
  function clearPending(target) {
    if (!target) return;
    if (target.interventionId) pendingByIntervention.delete(target.interventionId);
    if (asked === target) asked = null;
  }

  /* The reader changed their selection before committing. Recorded, not acted
   * on — hesitation is not the same as being wrong. interventionId (step 5,
   * optional): resolves the specific pending card this revision belongs to
   * under concurrency; omitted, behaves exactly as before (the shared
   * `asked` slot). */
  function revise(interventionId) {
    const target = resolvePending(interventionId);
    if (target) target.revisions += 1;
  }

  /* They went back to the passage before answering, which is a legitimate
   * thing to do and is worth knowing when reading the receipt later. */
  function markScrollBack(interventionId) {
    const target = resolvePending(interventionId);
    if (target) target.scrolledBack = true;
  }

  /* Call with the reader's answer. Produces the signal the engine consumes.
   *
   * `confidence` — 'low', 'high', or omitted/null — is captured at the same
   * moment as the answer, not probed afterward. A post-hoc "are you sure?"
   * leaks the result if it appears more often after wrong answers; capturing
   * it at commit time cannot leak, since it is asked identically regardless
   * of what the answer turns out to be (CLAUDE.md, confidence calibration).
   * Skippable — a reader who didn't rate it gets null here, not a forced
   * guess, and null must never be treated as either 'low' or 'high'.
   *
   * interventionId (step 5, optional trailing param, same shape on every
   * terminal function below): when supplied, resolves THIS SPECIFIC
   * pending card via the map rather than the shared `asked` slot — see
   * this factory's own top-of-closure comment. Omitted, every existing
   * caller (before this item, and quiz.js's own single-question-at-a-time
   * flow) behaves byte-for-byte as before. */
  function answer(chosenIndex, question, confidence, interventionId) {
    const target = resolvePending(interventionId);
    if (!target) return null;
    const correct = Number(chosenIndex) === Number(question?.answerIndex);
    const latencyMs = now() - target.askedAt;
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
      level: target.level,
      latencyMs,
      slow: latencyMs > slowAnswerMs,
      revisions: target.revisions,
      scrolledBack: target.scrolledBack,
      span: target.span,
      paragraphKey: target.paragraphKey,
      knowledgeUnitId: target.knowledgeUnitId,
      paragraphIndex: target.paragraphIndex,
      questionId: target.questionId,
      source: target.source,
      interventionId: target.interventionId,
    };

    history.push(record);
    pending = record;
    clearPending(target);
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
  function answerGraded(answerText, verdict, confidence, interventionId) {
    const target = resolvePending(interventionId);
    if (!target) return null;
    const latencyMs = now() - target.askedAt;
    const normalizedConfidence = confidence === 'low' || confidence === 'high' ? confidence : null;
    const normalizedVerdict = verdict === 'correct' || verdict === 'incorrect' ? verdict : 'unknown';

    const record = {
      type: 'response',
      subtype: normalizedVerdict,
      correct: normalizedVerdict === 'unknown' ? null : normalizedVerdict === 'correct',
      confidence: normalizedConfidence,
      gradingMethod: 'model',
      level: target.level,
      answerText: String(answerText || '').slice(0, MAX_ANSWER_TEXT_CHARS),
      latencyMs,
      slow: latencyMs > slowAnswerMs,
      revisions: target.revisions,
      scrolledBack: target.scrolledBack,
      span: target.span,
      paragraphKey: target.paragraphKey,
      knowledgeUnitId: target.knowledgeUnitId,
      paragraphIndex: target.paragraphIndex,
      questionId: target.questionId,
      source: target.source,
      interventionId: target.interventionId,
    };

    history.push(record);
    pending = record;
    clearPending(target);
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
  function respond(answerText, confidence, interventionId) {
    const target = resolvePending(interventionId);
    if (!target) return null;
    const latencyMs = now() - target.askedAt;
    const normalizedConfidence = confidence === 'low' || confidence === 'high' ? confidence : null;

    const record = {
      type: 'response',
      subtype: 'ungraded',
      correct: null,
      confidence: normalizedConfidence,
      gradingMethod: 'none',
      level: target.level,
      answerText: String(answerText || '').slice(0, MAX_ANSWER_TEXT_CHARS),
      latencyMs,
      slow: latencyMs > slowAnswerMs,
      revisions: target.revisions,
      scrolledBack: target.scrolledBack,
      span: target.span,
      paragraphKey: target.paragraphKey,
      knowledgeUnitId: target.knowledgeUnitId,
      paragraphIndex: target.paragraphIndex,
      questionId: target.questionId,
      source: target.source,
      interventionId: target.interventionId,
    };

    history.push(record);
    pending = record;
    clearPending(target);
    return record;
  }

  /* The reader closed the card without answering. That is not a wrong answer
   * and must not be scored as one — it is a refusal to be tested, which is
   * their right, and the system should read it as "stop asking" rather than
   * as evidence of anything about their comprehension. */
  function dismiss(interventionId) {
    const target = resolvePending(interventionId);
    if (!target) return null;
    const record = {
      type: 'response',
      subtype: 'dismissed',
      correct: null,
      gradingMethod: 'none',
      level: target.level,
      latencyMs: now() - target.askedAt,
      span: target.span,
      paragraphKey: target.paragraphKey,
      knowledgeUnitId: target.knowledgeUnitId,
      source: target.source,
      interventionId: target.interventionId,
    };
    history.push(record);
    pending = record;
    clearPending(target);
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
