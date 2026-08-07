/* response-signals.js — what the reader actually answered
 *
 * Top of the signal hierarchy, and the only ground truth in the system.
 * Everything else infers comprehension from behaviour; this observes it.
 * A wrong answer is not evidence that someone is probably struggling — it is
 * a reader failing to retrieve something they just read.
 *
 * So these outrank every telemetry signal in the engine, and a correct answer
 * is as informative as a wrong one: it says the slow reading that triggered
 * the question was fine, and the system should stop pressing.
 *
 * The auxiliary measures — how long they took, whether they changed their
 * mind, whether they scrolled back to look — are recorded for the receipt.
 * None of them are used to override the answer itself.
 */

export const SLOW_ANSWER_MS = 20000;

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
      paragraphKey: context.paragraphKey || null,
      askedAt: now(),
      revisions: 0,
      scrolledBack: false,
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

  /* Call with the reader's answer. Produces the signal the engine consumes. */
  function answer(chosenIndex, question) {
    if (!asked) return null;
    const correct = Number(chosenIndex) === Number(question?.answerIndex);
    const latencyMs = now() - asked.askedAt;

    const record = {
      type: 'response',
      subtype: correct ? 'correct' : 'incorrect',
      correct,
      latencyMs,
      slow: latencyMs > slowAnswerMs,
      revisions: asked.revisions,
      scrolledBack: asked.scrolledBack,
      span: asked.span,
      paragraphKey: asked.paragraphKey,
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
      latencyMs: now() - asked.askedAt,
      span: asked.span,
      paragraphKey: asked.paragraphKey,
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
    present, revise, markScrollBack, answer, dismiss,
    signal, stats,
    isPending: () => asked !== null,
    history: () => history.slice(),
  };
}
