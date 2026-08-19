/* grading-client.js — free-text answer grading, extracted for reuse (item 43)
 *
 * Pulled out of host.js so quiz.js — a normal extension page, not the
 * content-script context host.js is built for — can grade free-text
 * answers on the quiz page under the exact same defense-in-depth rules as
 * the floating question card, rather than a second hand-written copy of
 * them slowly drifting from the original. See tests/contract/grading.js
 * for the server-side mirror of these same rules, and question-card.js's
 * own commit() for the fourth, independent guard on top of this one (the
 * UI layer refuses to ever render "wrong" at scenario, even if every layer
 * below it somehow failed).
 *
 * Returns { verdict: 'correct'|'incorrect'|'unknown', span: string|null }
 * — never anything outside that shape, and never throws. Every failure
 * path (wrong level, oversized answer, rate limit, network failure, a
 * response that fails shape validation) resolves to the same UNGRADED
 * value. A server response is never trusted just because it arrived
 * looking right — the scenario-incorrect gate and the span-groundedness
 * check below are the CLIENT's own independent re-checks, not a stand-in
 * for the server's.
 */
const GRADABLE_LEVELS = ['free_recall', 'scenario'];
// Mirrors tests/contract/grading.js's MAX_ANSWER_CHARS — checked before any
// rate-limit budget or network call is spent on an answer that was always
// going to be refused.
const MAX_GRADING_ANSWER_CHARS = 500;
const UNGRADED = Object.freeze({ verdict: 'unknown', span: null });

export function createGradingClient({ callBackend, getGradeUrl, checkBudget, log, warn } = {}) {
  async function fetchGrading({ passage, span, spanRole, question, answer, level } = {}) {
    // recognition (deterministic) and adversarial (never graded) are both
    // refused here structurally — not by trusting every call site to
    // remember not to call this function for either.
    if (!GRADABLE_LEVELS.includes(level)) return { ...UNGRADED };

    const trimmedAnswer = String(answer || '').trim();
    if (!trimmedAnswer || trimmedAnswer.length > MAX_GRADING_ANSWER_CHARS) return { ...UNGRADED };

    if (checkBudget && !checkBudget('grade', level)) return { ...UNGRADED };

    try {
      // Separate, named, delimited fields — passage and reader text are
      // never concatenated into one string here or anywhere upstream of the
      // server's own prompt construction (tests/contract/grading.js's
      // buildGradingPrompt places each in its own labelled section).
      const body = {
        passage: String(passage || '').slice(0, 4000),
        span: String(span || '').slice(0, 400),
        spanRole: spanRole === 'principle' ? 'principle' : 'answer',
        question: String(question || '').slice(0, 500),
        answer: trimmedAnswer,
        level,
      };
      const resp = await callBackend('apiPost', getGradeUrl(), body);
      if (!resp.ok) { log?.(`Grading unavailable (${resp.status || resp.error || 'error'})`); return { ...UNGRADED }; }
      const j = resp.data;
      if (!j || typeof j !== 'object') return { ...UNGRADED };

      const verdict = j.verdict;
      if (verdict !== 'correct' && verdict !== 'incorrect' && verdict !== 'unknown') return { ...UNGRADED };
      // Never assert "wrong" at scenario, no matter what came back over the
      // wire — a second, independent gate on top of the server's own.
      if (level === 'scenario' && verdict === 'incorrect') return { ...UNGRADED };
      if (verdict === 'unknown') return { ...UNGRADED };

      // correct/incorrect both require a real, verbatim span from the
      // PASSAGE THE CLIENT ITSELF ALREADY HAS — the same invented-evidence
      // check questions.js's own span validation applies, run again here
      // rather than only trusted from the network.
      const normalisedPassage = String(passage || '').replace(/\s+/g, ' ').trim();
      const returnedSpan = String(j.span || '').replace(/\s+/g, ' ').trim();
      if (returnedSpan.length < 10 || !normalisedPassage.includes(returnedSpan)) return { ...UNGRADED };

      return { verdict, span: returnedSpan };
    } catch (e) {
      warn?.('fetchGrading failed:', e.message);
      return { ...UNGRADED };
    }
  }

  return { fetchGrading };
}
