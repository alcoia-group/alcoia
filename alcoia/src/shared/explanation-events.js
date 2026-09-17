/* explanation-events.js — logging that an on-demand explanation was
 * requested for a specific selection (item DC-2 follow-up)
 *
 * Same injectable-dependency, never-throws shape as outcomes.js/
 * kinematics.js — read those files' own headers first, this one repeats
 * only what differs.
 *
 * Confirmed by reading alcoiaServer's
 * src/http/routes/explanation-events.js directly, not assumed — same
 * bounded-exception shape as scroll_sessions (CLAUDE.md §4): pseudonymous,
 * assignment-required, participant-checked, write-only, no read path
 * anywhere in that codebase.
 *
 *   POST /api/assignments/:assignmentId/explanation-events
 *     { selectionType, paragraphIndex? } -> 200 { logged: true }
 * `selectionType` must be one of 'equation' | 'figure' | 'term' | 'caption'
 * (the server's own VALID_SELECTION_TYPES) — this module does not
 * duplicate that allowlist client-side; a wrong value is the server's own
 * 422 invalid_selection_type to report, not something to guess-correct
 * here. The caller (host.js) is what maps selection-explain.js's own
 * `type` values onto these — see that file's own comment for the one
 * value ('caption') nothing on the client can currently produce.
 *
 * Pseudonym is never sent — derived server-side from the assignment's own
 * salt and the authenticated account, identical mechanism to
 * outcomes.pseudonym (CLAUDE.md §4).
 *
 * FIRE-AND-FORGET, same pattern as outcomes.js's calls (mid-session, not
 * at unload) — an ordinary fetch() is fine here; unlike kinematics.js's
 * calls, this one never fires from a beforeunload handler, so keepalive
 * is not needed.
 */

export function createExplanationEventsManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const explanationEventsUrl = opts.explanationEventsUrl; // full URL, assignmentId already baked in by the caller

  /* Returns { ok: true } or { ok: false, error }. Never throws. The caller
   * (host.js's reportExplanationEvent) already discards this result — same
   * reasoning as outcomes.submit()'s own comment: returned anyway so this
   * stays testable without a real network call. */
  async function submit({ selectionType, paragraphIndex } = {}) {
    if (typeof selectionType !== 'string' || !selectionType) {
      return { ok: false, error: 'invalid_selection_type' };
    }
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!explanationEventsUrl || !fetchImpl) return { ok: false, error: 'no_explanation_events_url' };

    const body = { selectionType };
    // Same strict-type coercion outcomes.js's server-side twin already
    // documents for this exact field: a wrong type is never sent as if it
    // were a real index, it's just omitted — the server's own 422 path for
    // a malformed request is for a malformed selectionType, not this.
    if (Number.isInteger(paragraphIndex) && paragraphIndex >= 0) {
      body.paragraphIndex = paragraphIndex;
    }

    try {
      const resp = await fetchImpl(explanationEventsUrl, {
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
