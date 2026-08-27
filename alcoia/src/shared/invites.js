/* invites.js — accepting a class invite, and releasing a held seat (item S6)
 *
 * Same shape as install-token.js/session.js/entitlements.js/billing.js:
 * small, injectable dependencies, never throws, every failure resolves to
 * an explicit `{ ok: false, error }`.
 *
 * Every field name is copied from reading alcoiaServer directly, not
 * inferred:
 *   POST /api/invites/accept    { token } -> { classId, seatId, role }
 *     (src/http/routes/invites.js)
 *   POST /api/seats/:id/release -> { released: true }
 *     (src/http/routes/seats.js)
 *
 * A REAL GAP, confirmed by reading every route in the server, not
 * assumed away: there is no endpoint anywhere that resolves a classId (or
 * an orgId — accept's own response does not even return one) into a human
 * name. The only class-detail route (`GET /api/classes/:classId/members`)
 * is console-kind-gated and instructor-authorized — a student's own
 * membership is never readable back. So "which class, which org" (this
 * item's own brief) can only ever show the raw classId here until a
 * student-facing membership-detail endpoint exists server-side. Flagged in
 * the PR, not solved by inventing one.
 *
 * A second gap, same root cause: there is no "list my seats" endpoint
 * either. What this file stores locally (src/popup/join-class.js's own
 * sra_class_membership key) after a successful accept is the ONLY record
 * this extension has of which seat to release later — if that storage is
 * ever cleared without the reader also visiting "Leave this class" first,
 * the account's entitlement stays correctly granted server-side (it is
 * genuinely seat-backed, not client-side state), but this extension loses
 * the ability to call release() for it until the reader finds another way
 * to identify the seat.
 *
 * acknowledgeLtiDisclosure() (item S6/E4 follow-up) is a THIRD entry into
 * the same disclosure screen (join-class.js), for LTI launches specifically
 * — confirmed by reading alcoiaServer's src/http/routes/lti.js directly,
 * not assumed:
 *   POST /api/lti/disclosure/ack  { acknowledged: true, ackCode }
 *     -> { sessionToken, kind: 'lti', classId, assignmentId, redirectTo }
 * Unlike acceptInvite()/releaseSeat(), this call carries NO Authorization
 * header — there is no session yet at this point in an LTI launch; a
 * successful ack is what mints one, the same "authenticates with no prior
 * session" shape session.js's own exchangeCode() already has for the
 * magic-link path. The response also has no seatId/role field at all
 * (unlike accept's), so a seat produced this way is stored locally with
 * both null — join-class.js's own "member" display never reads either,
 * only classId; the one thing that degrades is the existing "Leave this
 * class" button, which cannot release a seat it has no id for. That is a
 * real, honest consequence of the confirmed response shape, not
 * something invented here to paper over.
 */

export function createInvitesManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const acceptUrl = opts.acceptUrl;
  const seatsUrl = opts.seatsUrl;
  const ltiAckUrl = opts.ltiAckUrl;

  function authHeaders(token) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  /* Extracts an invite token from whatever the reader pasted — a bare
   * code, or a full link carrying it as a `token` or `code` query
   * parameter. The confirmed request shape only ever needs the bare
   * token; this is purely a client-side convenience so "a link or a
   * code" (this item's own brief) both work from one field. Never
   * invents a link FORMAT of its own — just reads whichever of the two
   * common query param names is present, and otherwise treats the whole
   * input as the token verbatim. */
  function extractToken(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    try {
      const url = new URL(trimmed);
      return url.searchParams.get('token') || url.searchParams.get('code') || trimmed;
    } catch (e) {
      return trimmed; // not a URL — treat as a bare code
    }
  }

  /* Returns { ok: true, classId, seatId, role } or { ok: false, error }.
   * `error` is the server's own code when one came back (invalid_invite,
   * invite_revoked, invite_expired, domain_mismatch, already_a_member,
   * invite_full, seat_capacity_exceeded, invalid_request), or a
   * client-side one (no_session, no_token, malformed_response,
   * network_error). Never parsed from prose. */
  async function acceptInvite(rawLinkOrCode) {
    const token = extractToken(rawLinkOrCode);
    if (!token) return { ok: false, error: 'no_token' };

    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!acceptUrl || !fetchImpl) return { ok: false, error: 'no_accept_url' };

    try {
      const resp = await fetchImpl(acceptUrl, {
        method: 'POST',
        headers: authHeaders(session.token),
        body: JSON.stringify({ token }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}` };
      }
      if (!data || typeof data.classId !== 'string' || !data.classId
        || typeof data.seatId !== 'string' || !data.seatId) {
        return { ok: false, error: 'malformed_response' };
      }
      return { ok: true, classId: data.classId, seatId: data.seatId, role: data.role || null };
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
  }

  /* Returns { ok: true } or { ok: false, error }. 'seat_not_found' can
   * legitimately mean "already released" if the caller's own local
   * record went stale — the server treats a second release as
   * idempotent success, this file does not second-guess that. */
  async function releaseSeat(seatId) {
    if (!seatId) return { ok: false, error: 'no_seat_id' };
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!seatsUrl || !fetchImpl) return { ok: false, error: 'no_seats_url' };

    try {
      const resp = await fetchImpl(`${seatsUrl}/${encodeURIComponent(seatId)}/release`, {
        method: 'POST',
        headers: authHeaders(session.token),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}` };
      }
      if (!data || data.released !== true) return { ok: false, error: 'malformed_response' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
  }

  /* Returns { ok: true, sessionToken, classId, assignmentId, redirectTo }
   * or { ok: false, error }. `error` is the server's own code when one
   * came back (acknowledgement_required, invalid_request, invalid_code,
   * code_already_used, code_expired), or a client-side one (no_ack_code,
   * no_ack_url, malformed_response, network_error). Never sends
   * `acknowledged` as anything but the literal `true` this function's own
   * signature already guarantees — there is no "acknowledge=false" caller
   * anywhere, matching the server's own requirement that this be explicit,
   * never inferred. */
  async function acknowledgeLtiDisclosure(ackCode) {
    const code = String(ackCode || '').trim();
    if (!code) return { ok: false, error: 'no_ack_code' };
    if (!ltiAckUrl || !fetchImpl) return { ok: false, error: 'no_ack_url' };

    try {
      const resp = await fetchImpl(ltiAckUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledged: true, ackCode: code }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}` };
      }
      if (!data || typeof data.sessionToken !== 'string' || !data.sessionToken
        || typeof data.classId !== 'string' || !data.classId) {
        return { ok: false, error: 'malformed_response' };
      }
      return {
        ok: true,
        sessionToken: data.sessionToken,
        classId: data.classId,
        assignmentId: typeof data.assignmentId === 'string' ? data.assignmentId : null,
        redirectTo: typeof data.redirectTo === 'string' ? data.redirectTo : null,
      };
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
  }

  return { acceptInvite, releaseSeat, acknowledgeLtiDisclosure };
}
