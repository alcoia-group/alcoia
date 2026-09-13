/* epistemic-engine.js — selects the next question type from demonstrated
 * failure, not from a rotation (item 44)
 *
 * Every other product in this category rotates question formats on a
 * schedule. This does something different: it diagnoses WHAT KIND of
 * understanding is missing and picks the format that tests for it.
 *
 *   correct at recognition, fails free recall   -> "recognises but cannot
 *                                                    retrieve" -> free recall
 *   correct at recall, fails scenario            -> "retrieves but cannot
 *                                                    transfer" -> scenario
 *   correct at scenario, confidence miscalibrated -> "applies but
 *                                                    overconfident" -> adversarial
 *
 * The ladder is recognition -> free_recall -> scenario -> adversarial. Climb
 * on demonstrated success, descend on failure — except free_recall, which
 * retries itself rather than falling back to recognition (a reader who got
 * recognition right has already demonstrated the floor; failing recall once
 * is not evidence they lost that). Scenario can never be marked "incorrect"
 * (item 43 — a model grading a scenario answer may only ever return
 * 'correct' or 'unknown', never 'incorrect') so "failing" a scenario always
 * means an inconclusive grade, not a wrong one, and it descends one rung —
 * to free_recall, never all the way to recognition — so it never reads as a
 * correction, only as a difficulty adjustment.
 *
 * SCOPE: everything here is pure and stateless. It reads a history array the
 * caller supplies and returns a decision; it never stores anything itself.
 * The caller (host.js) supplies session-scoped history — response-signals.js's
 * in-memory `history()` for the in-page card, or the same history at
 * quiz-generation time for the quiz. Nothing here persists across documents
 * or across days — there is no schema, no storage key, and no plan to add
 * one. That is Level C and is out of scope by design (CLAUDE.md §5).
 *
 * Adversarial is reached ONLY from `scenario` + a correct grade + a
 * SYSTEMATIC (not one-off) pattern of high-confidence wrong answers
 * elsewhere in the session. A failing reader is structurally unable to
 * reach it — the branch that returns 'adversarial' is guarded by
 * `correct === true` above it, so there is no path from a wrong or
 * inconclusive answer at any level to a challenge question. That guard is
 * enough on its own to guarantee it; nothing calling this module needs a
 * second check.
 */

export const LADDER = Object.freeze(['recognition', 'free_recall', 'scenario', 'adversarial']);

// "Systematic" requires more than one data point — a single wrong
// high-confidence answer is a mistake, not a pattern, and punishing it with
// a challenge question would just be hostile (CLAUDE.md, item 44's own
// warning about tone). Both numbers are deliberately small and session-
// local: this reads only the handful of answers given so far this session,
// never anything from a prior day or a prior document.
export const OVERCONFIDENCE_MIN_SAMPLES = 3;
export const OVERCONFIDENCE_WRONG_RATE = 0.4;

/* `sessionAnswers`: an array of { confidence, correct } for every answered
 * (non-dismissed) question this session, across every concept — not scoped
 * to the one concept currently being escalated. Overconfidence is a trait
 * of how the reader is answering in general, not a property of any single
 * question, which is why this looks at the whole session's pattern rather
 * than only the current concept's history. */
export function isSystematicallyOverconfident(sessionAnswers = []) {
  const highConfidenceGraded = sessionAnswers.filter(
    (a) => a && a.confidence === 'high' && (a.correct === true || a.correct === false),
  );
  if (highConfidenceGraded.length < OVERCONFIDENCE_MIN_SAMPLES) return false;
  const wrong = highConfidenceGraded.filter((a) => a.correct === false).length;
  return wrong / highConfidenceGraded.length >= OVERCONFIDENCE_WRONG_RATE;
}

/* `lastAttempt`: { level, correct } describing the most recent GRADED
 * attempt at this concept, or null/undefined if it has never been tested
 * this session. `correct` is `true`, `false`, or `null` (an inconclusive —
 * "unknown" — model grade; only free_recall and scenario can produce this).
 * A dismissal is not an attempt and must never be passed in here — the
 * reader declining to answer says nothing about what they know, and must
 * not move them anywhere on the ladder (CLAUDE.md: "A dismissal asserts
 * nothing at all").
 *
 * `sessionAnswers`: see isSystematicallyOverconfident above — only consulted
 * at the scenario rung, where it is the entire justification for ever
 * reaching adversarial. */
export function nextLevel(lastAttempt, sessionAnswers = []) {
  if (!lastAttempt || !LADDER.includes(lastAttempt.level)) return 'recognition';
  const { level, correct } = lastAttempt;

  if (level === 'recognition') {
    // Nowhere below recognition to descend to — a wrong answer here just
    // asks again, which is not a demotion, only the absence of a promotion.
    return correct === true ? 'free_recall' : 'recognition';
  }

  if (level === 'free_recall') {
    // Deliberately does NOT fall back to recognition on failure or an
    // inconclusive grade — the reader already demonstrated recognition to
    // get here, and re-litigating that would read as punishment for a
    // single miss rather than a difficulty adjustment.
    return correct === true ? 'scenario' : 'free_recall';
  }

  if (level === 'scenario') {
    // correct !== true covers both an inconclusive ('unknown') grade and,
    // structurally, an 'incorrect' one that should never reach here in the
    // first place (item 43) — either way, "failing" a scenario returns the
    // reader to recall, one rung down, never told they went backwards.
    if (correct !== true) return 'free_recall';
    return isSystematicallyOverconfident(sessionAnswers) ? 'adversarial' : 'scenario';
  }

  if (level === 'adversarial') {
    // Adversarial answers are never graded (item 43) — there is no
    // correct/incorrect signal to climb or descend on, and nothing above it
    // to climb to. Drops back to scenario so re-entry always requires
    // requalifying via a fresh correct-and-overconfident scenario answer,
    // keeping adversarial rare rather than a new steady state.
    return 'scenario';
  }

  return 'recognition';
}

/* Convenience wrapper for the common case: the caller has a full
 * response-signals-shaped history array (paragraphKey/level/correct/
 * confidence/subtype on every record) and wants the level for one concept.
 * Still pure — no DOM, no server, no storage read. Used identically by
 * host.js's in-page paths (handleAsk, runSessionRecall) and its quiz
 * generation path (runQuiz) — the "same engine, same rules" requirement is
 * satisfied structurally, by both calling this one function, not by two
 * hand-written copies that could drift apart. */
export function pickLevelForConcept(paragraphKey, history = []) {
  const graded = (history || []).filter((h) => h && h.subtype !== 'dismissed');

  const attemptsForConcept = graded.filter((h) => h.paragraphKey === paragraphKey);
  const lastAttempt = attemptsForConcept.length
    ? attemptsForConcept[attemptsForConcept.length - 1]
    : null;

  const sessionAnswers = graded.map((h) => ({ confidence: h.confidence, correct: h.correct }));

  return nextLevel(lastAttempt ? { level: lastAttempt.level, correct: lastAttempt.correct } : null, sessionAnswers);
}

/* Item 44's own tone requirement: adversarial must never read as hostile,
 * least of all to a reader who has been doing well. The default evidence
 * line at every other rung already explains why the system interrupted
 * (skimming, struggling, a review the reader asked for); adversarial is the
 * one case where the honest reason — "you have been right, and confident,
 * often enough that this is worth pressure-testing" — needs saying
 * plainly instead of reusing struggle-framed copy, so the challenge reads as
 * rigour extended to someone doing well, not suspicion. Returns null for
 * every other level so callers keep whatever evidence line they already
 * had. */
export function evidenceLineForLevel(level) {
  if (level === 'adversarial') {
    return 'You have been right and confident on this. Here is a harder edge of it.';
  }
  return null;
}
