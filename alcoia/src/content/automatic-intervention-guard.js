/* automatic-intervention-guard.js — Step 12A: one shared, in-memory lock so
 * the AUTOMATIC (non-reader-initiated) question-generating paths cannot both
 * be inside AI generation/presentation at the same time.
 *
 * Why this exists: the Step 12 audit (intervention-generation/frequency)
 * found that orchestrator.js's own `interventionInFlight` only guards the
 * state-subscription dispatch that leads to handleAsk() — it has no idea
 * checkRetentionCandidate() exists, because that function is invoked
 * fire-and-forget from host.js's onParagraphRead callback, never through
 * orchestrator.js at all. A due retention candidate on one paragraph and a
 * state-driven 'ask' on another can therefore both pass their own policy
 * gate and both call fetchQuestions() concurrently — two genuine, wasted AI
 * calls for what the reader experiences as one moment of reading. This
 * module is the smallest shared boundary that closes that specific gap:
 * host.js's handleAsk() and checkRetentionCandidate() both acquire it,
 * right after their own policy check has already allowed the candidate and
 * right before the first AI call.
 *
 * Deliberately NOT a generalised concurrency primitive. Three operations,
 * synchronous, in-memory, one instance per createHost() call (so its
 * lifetime matches the content-script/page injection, same as every other
 * closure-scoped lock in host.js — quizGenerating, recallRunning). It knows
 * nothing about interventionPolicy (session cap, cooldown, paragraph dedup
 * all stay exactly where they already are), nothing about the AI-call rate
 * limiter (checkAiCallBudget), and nothing about the server. Reader-initiated
 * paths (session recall, quiz, manual fetchSummary calls) never touch this —
 * see CLAUDE.md's "reader-initiated actions spend no budget" principle,
 * unchanged and unaffected by this module.
 */
export function createAutomaticInterventionGuard() {
  let inFlight = false;

  return {
    /* Returns true and marks the guard held, or returns false if another
     * automatic path already holds it. Callers must release() in a
     * `finally`, however generation/presentation turns out — a thrown
     * error, a network failure, an empty result, or a rejected presentation
     * must never leave this permanently locked. */
    tryAcquire() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release() {
      inFlight = false;
    },
    isInFlight: () => inFlight,
  };
}
