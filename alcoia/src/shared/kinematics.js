/* kinematics.js — reporting a session's scroll-kinematics summary
 * (item DC-1a)
 *
 * Same injectable-dependency, never-throws shape as outcomes.js — read that
 * file's own header first, this one repeats only what differs.
 *
 * Confirmed by reading alcoiaServer's src/http/routes/scroll-sessions.js and
 * migrations/*_create-scroll-sessions.sql directly, not assumed — and not
 * built against the brief's own assumed shape, which asked for this to be
 * sendable for any signed-in session with an optional assignment context.
 * The real, shipped endpoint is narrower, deliberately: it REQUIRES a real
 * assignmentId (a 422 without one), and the authenticated account must hold
 * an active seat in that assignment's class (a 403 otherwise) — there is no
 * server-side path for a general "any signed-in reader" behavioral corpus,
 * and this module does not attempt to work around that; it just calls the
 * endpoint that exists. See host.js's own submitKinematics for the client
 * side of that same gate (assignmentId && getSession, mirroring
 * submitOutcome's identical gate for the identical reason).
 *
 *   POST /api/sessions/kinematics
 *     { assignmentId, kinematics: { duration_ms, scroll_events,
 *       velocity_p50, velocity_p95, velocity_variance, jitter_score,
 *       micro_correction_count, micro_correction_rate, acceleration_events,
 *       direction_changes, smooth_scroll_ratio }, collectionLabel? }
 *     -> 201 { recorded: true }
 * Every kinematics field is required and must be a finite number (server
 * rejects a partial object with 422 invalid_kinematics) — this module sends
 * exactly what the caller gives it and lets the server be the one source of
 * truth for which fields are required, rather than duplicating that list
 * here and risking the two drifting apart.
 *
 * Pseudonym is never sent — derived server-side from the assignment's own
 * salt and the authenticated account, identical mechanism to
 * outcomes.pseudonym, for the identical reason (CLAUDE.md §4).
 *
 * FIRE-AND-FORGET, CALLED AT PAGE UNLOAD (this item's own brief): unlike
 * outcomes.js's mid-session calls, this one is always invoked from a
 * beforeunload handler, where an ordinary fetch() is liable to be aborted
 * before it leaves the browser at all. `keepalive: true` is what lets a
 * short POST actually survive that moment — it is not available to
 * outcomes.js's own calls because none of them fire at unload, so this is a
 * genuine, deliberate difference from that file's pattern, not a copy-paste
 * miss. keepalive requests still carry a real body and headers (unlike
 * navigator.sendBeacon(), which cannot attach the Authorization header this
 * call needs), so the same Bearer-token relay outcomes.js uses still works.
 */

// This item's own brief: "Do not send data for sessions shorter than 30
// seconds (too short to be meaningful)." Matches session-tracker.js's own
// MIN_SESSION_MS exactly, as a value — kept as a separate constant rather
// than importing that one, since the two are independent "is this session
// worth keeping" decisions (one for the local session-report list, one for
// server submission) that currently happen to agree, not one shared rule.
export const MIN_SESSION_MS = 30000;

// Shared by content.js's and viewer.js's beforeunload handlers so the 30s
// floor and the "was there enough scroll history to summarise" check are
// each expressed once, not duplicated per call site.
export function shouldSubmitKinematics({ durationMs, kinematics }) {
  return typeof durationMs === 'number' && durationMs >= MIN_SESSION_MS && !!kinematics;
}

export function createKinematicsManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const kinematicsUrl = opts.kinematicsUrl;

  /* Returns { ok: true } or { ok: false, error }. Never throws. The caller
   * (host.js's submitKinematics) already discards this result — see that
   * file's own comment — but it is returned anyway for the same reason
   * outcomes.submit() does: testable without a real network call. */
  async function submit({ assignmentId, kinematics, collectionLabel } = {}) {
    if (typeof assignmentId !== 'string' || !assignmentId) {
      return { ok: false, error: 'invalid_assignment_id' };
    }
    if (!kinematics || typeof kinematics !== 'object') {
      return { ok: false, error: 'invalid_kinematics' };
    }
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!kinematicsUrl || !fetchImpl) return { ok: false, error: 'no_kinematics_url' };

    const body = { assignmentId, kinematics };
    if (typeof collectionLabel === 'string' && collectionLabel) body.collectionLabel = collectionLabel;

    try {
      const resp = await fetchImpl(kinematicsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify(body),
        keepalive: true,
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
