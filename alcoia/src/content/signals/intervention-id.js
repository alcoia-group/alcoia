/* intervention-id.js — a unique identity for one presented intervention
 * (intelligence-architecture audit, step 5)
 *
 * knowledgeUnitId (step 3) identifies WHAT content was involved — a
 * deterministic hash, so the same paragraph always produces the same id.
 * An intervention_id is the opposite: it identifies WHICH OCCURRENCE of an
 * interruption happened, so the SAME paragraph asked about twice must get
 * TWO DIFFERENT ids. A content hash is structurally the wrong tool for
 * that — this is randomness plus a timestamp, not a hash of anything.
 *
 * EXISTING PROJECT CONVENTION, reused rather than invented: quiz-store.js's
 * own randomId() is already exactly this shape —
 * `q_${now()}_${Math.random().toString(36).slice(2, 8)}` — a millisecond
 * timestamp plus a 6-character base36 random suffix, used to give each
 * saved quiz attempt a unique, non-content-derived id. This is the same
 * shape, with the "iv" prefix distinguishing an intervention id from a
 * quiz-store id or a knowledge-unit id ("k...") at a glance in a log or a
 * network payload.
 *
 * PRIVACY: contains no account id, email, pseudonym, or any other reader
 * identity — only a timestamp and randomness, both already public in the
 * sense that a request's own arrival time is visible to the server
 * regardless. This value identifies an EVENT, never a person (CLAUDE.md §2
 * invariant 2 — no fingerprinting; this is not derived from anything about
 * the reader's device or behaviour either).
 *
 * COLLISION: 36^6 (~2.2 billion) possible suffixes per millisecond, the
 * same order of magnitude collision-safety quiz-store.js's own randomId()
 * already accepts for its own ids — no new risk tolerance introduced here,
 * and no retry-on-conflict logic is added for the same reason none exists
 * for quiz-store.js's ids either.
 */

export function generateInterventionId(now = Date.now, random = Math.random) {
  return `iv_${now()}_${random().toString(36).slice(2, 8)}`;
}
