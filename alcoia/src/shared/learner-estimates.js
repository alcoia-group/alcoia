/* learner-estimates.js — the learner's own estimates for one assignment (Stage B).
 *
 *   GET {ASSIGNMENTS_URL}/:assignmentId/knowledge-state/estimates -> 200
 *     { estimates: [{ knowledgeUnitId, level, confidence, action, kind, reason, transferCheck?, transferLevel?, transferTier?, transferFocus? }], transferPreferred }
 *   transferCheck: the unit was explained and a new application-level question is still needed (the server decides the tier
 *   from its own clock; the page adds the 'two other paragraphs read' spacing). Labels only.
 *
 * Same shape and posture as retention.js: the caller builds the URL, this never throws, a failure means "no
 * estimates", and the reading flow then behaves exactly as it did before estimates existed. Labels and
 * hashes only come back: no counts, timestamps, or text. `action` is abstain | gather | intervene; a unit
 * with no entry has no recorded evidence, which the policy treats as "gather" (the normal behaviour).
 * The server is the only source of truth; the host keeps a copy of the latest answer and drops a unit's
 * entry the moment new evidence for it is on its way, so a stale estimate never outlives the evidence
 * that contradicts it. */
export function createLearnerEstimatesManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const estimatesUrl = opts.estimatesUrl;

  async function getEstimates() {
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) return { ok: false, error: 'no_session', estimates: [] };
    if (!estimatesUrl || !fetchImpl) return { ok: false, error: 'no_estimates_url', estimates: [] };
    try {
      const resp = await fetchImpl(estimatesUrl, { method: 'GET', headers: { Authorization: `Bearer ${session.token}` } });
      if (!resp.ok) {
        const data = await resp.json().catch(() => null);
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}`, estimates: [] };
      }
      const data = await resp.json().catch(() => null);
      return { ok: true, estimates: data && Array.isArray(data.estimates) ? data.estimates : [], transferPreferred: data?.transferPreferred === true };
    } catch (e) {
      return { ok: false, error: 'network_error', estimates: [] };
    }
  }

  return { getEstimates };
}
