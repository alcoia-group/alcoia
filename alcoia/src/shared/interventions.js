/* interventions.js — recording that a specific intervention was presented
 * (intelligence-architecture audit, step 5)
 *
 * Same injectable-dependency, never-throws shape as outcomes.js/
 * explanation-events.js — read those files' own headers first, this one
 * repeats only what differs.
 *
 *   POST /api/assignments/:id/interventions
 *     { interventionId, knowledgeUnitId?, paragraphIndex?, type, text? } -> 201 { recorded: true }
 *
 * `text` (step 19, Content Intelligence's real trigger): the exact same
 * bounded passage `identity`/`knowledgeUnitId` was already computed from
 * at this call's own call site (host.js already holds it — handleAsk's own
 * `text` param, runSessionRecall's `entry.text`, checkRetentionCandidate's
 * own `text` param) — never re-fetched, never the whole page, never more
 * than the one paragraph already in hand. Optional: every existing caller
 * that doesn't pass it keeps behaving exactly as before (the server treats
 * its absence as "no Content Intelligence signal this time," never a
 * degraded or rejected submission — see alcoiaServer's own interventions
 * route). No client-side length cap is enforced here deliberately: a
 * single paragraph is already naturally far under any reasonable bound,
 * and the server is the authoritative bound-check (CLAUDE.md's own
 * standing "the server never trusts a client-side check" convention,
 * already true for every other field this same submit() sends).
 *
 * Fires once, the moment a question-bearing intervention actually reaches
 * the screen (host.js's handleAsk/runSessionRecall, quiz.js's own
 * renderQuestion) — BEFORE any answer, independent of whether one ever
 * comes. This is what makes "intervention -> no subsequent attributed
 * outcome" a real, queryable state server-side rather than something only
 * inferable after the fact: without a durable record of presentation, a
 * dismissed or abandoned intervention would leave no trace at all, and
 * "no outcome exists for this id" would be indistinguishable from "this id
 * was never even generated."
 *
 * Pseudonym is never sent — same reasoning as outcomes.js/
 * explanation-events.js (CLAUDE.md §4): the server derives it, and this
 * record carries no learner identity of any kind, not even a derivable
 * one (see intervention-id.js's own header — the id itself is pure
 * timestamp+randomness, and nothing else in this body is learner-linked
 * either).
 *
 * FIRE-AND-FORGET, same pattern as outcomes.js/explanation-events.js's own
 * calls (mid-session, not at unload) — an ordinary fetch() is fine here.
 */

export function createInterventionsManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const interventionsUrl = opts.interventionsUrl; // full URL, assignmentId already baked in by the caller

  /* Returns { ok: true } or { ok: false, error }. Never throws — the
   * caller (host.js/quiz.js) already discards this result, same reasoning
   * as outcomes.submit()'s own comment: returned anyway so this stays
   * testable without a real network call. */
  async function submit({ interventionId, knowledgeUnitId, paragraphIndex, type, text, policyAction } = {}) {
    if (typeof interventionId !== 'string' || !interventionId) {
      return { ok: false, error: 'invalid_intervention_id' };
    }
    if (typeof type !== 'string' || !type) {
      return { ok: false, error: 'invalid_type' };
    }
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!interventionsUrl || !fetchImpl) return { ok: false, error: 'no_interventions_url' };

    const body = { intervention_id: interventionId, type };
    // Same strict-type coercion shape every other optional-field client
    // manager in this codebase already uses (explanation-events.js's own
    // paragraphIndex, outcomes.js's own knowledge_unit_id) — a wrong type
    // is simply omitted, never sent as if it were real, and never turned
    // into a client-side 422 the server's own validation already owns.
    if (typeof knowledgeUnitId === 'string' && knowledgeUnitId) body.knowledge_unit_id = knowledgeUnitId;
    if (Number.isInteger(paragraphIndex) && paragraphIndex >= 0) body.paragraph_index = paragraphIndex;
    // Step 19: the exact passage identity was already computed from --
    // never a different or re-derived string. Omitted (not sent as an
    // empty string) when the caller has none, same coercion shape as
    // every other optional field here.
    if (typeof text === 'string' && text) body.text = text;
    // Which policy action produced this (retrieve/explain/repair). Describes
    // the intervention only; the server ignores any other value.
    if (policyAction === 'retrieve' || policyAction === 'explain' || policyAction === 'repair') body.policy_action = policyAction;

    try {
      const resp = await fetchImpl(interventionsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => null);
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
  }

  return { submit };
}
