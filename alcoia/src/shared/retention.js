/* retention.js — fetches the account's due Knowledge State candidates,
 * scoped to one assignment (intelligence-architecture audit, step 7 built,
 * step 10 context-scoped)
 *
 * Same injectable-dependency, never-throws shape as outcomes.js/
 * interventions.js — read those files' own headers first, this one
 * repeats only what differs.
 *
 *   GET {ASSIGNMENTS_URL}/:assignmentId/knowledge-state/due -> 200
 *     { candidates: [{ knowledgeUnitId, retentionStage, nextRetrievalAt }] }
 *
 * dueUrl is passed in fully built by the caller (host.js), already
 * carrying the one assignmentId this session is for — this module has no
 * assignment-specific logic of its own, it just fetches whatever URL it's
 * given, the same "caller builds the URL, this module just calls it" shape
 * interventions.js/explanation-events.js already use.
 *
 * Fires ONCE, at host.js construction, gated the identical way every other
 * server-reporting manager in this codebase already is (assignmentId +
 * getSession both present) — there is no separate "account session without
 * an assignment" path in this extension today, so this reuses that exact
 * boundary rather than inventing a new one. The result is never re-fetched
 * mid-session; a knowledge unit that becomes due after this call simply
 * isn't picked up until the next session. A real, disclosed V1
 * simplification, not an oversight.
 *
 * Returns only knowledgeUnitId/retentionStage/nextRetrievalAt per
 * candidate, NEVER paragraph text or anything reconstructable to it — the
 * server has no content to send back (knowledge_unit_id is a hash, not a
 * content database). Matching a due candidate against real text happens
 * entirely client-side, against whatever the reader is ALREADY reading —
 * see host.js's own checkRetentionCandidate for that half.
 */

export function createRetentionManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const dueUrl = opts.dueUrl;

  /* Returns { ok: true, candidates: [...] } or { ok: false, error }. Never
   * throws — the caller (host.js) can safely treat a failure as "nothing
   * due right now," the same fail-open posture every other client manager
   * in this codebase already takes for a non-critical background fetch. */
  async function getDue() {
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session', candidates: [] };
    }
    if (!dueUrl || !fetchImpl) return { ok: false, error: 'no_due_url', candidates: [] };

    try {
      const resp = await fetchImpl(dueUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => null);
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}`, candidates: [] };
      }
      const data = await resp.json().catch(() => null);
      const candidates = (data && Array.isArray(data.candidates)) ? data.candidates : [];
      return { ok: true, candidates };
    } catch (e) {
      return { ok: false, error: 'network_error', candidates: [] };
    }
  }

  return { getDue };
}
