/* outcomes.js — reporting a real reading signal against a specific
 * assignment (item S6/E4 follow-up)
 *
 * Same shape as invites.js/assignments.js: injectable dependencies, never
 * throws, every failure resolves to `{ ok: false, error }`. Loaded via
 * loadModule() from host.js (not a static import) — host.js itself is
 * loaded both as a real ES module (reading-bridge.js) and dynamically
 * (content.js, a content script that cannot use static `import`), so
 * every one of ITS OWN sub-dependencies goes through the same injected
 * loader regardless of which context constructed it. See host.js's own
 * header.
 *
 * Confirmed by reading alcoiaServer's src/http/routes/outcomes.js
 * directly, not assumed:
 *   POST /api/assignments/:id/outcomes
 *     { paragraph_index, struggled?, question_id?, correct?, confidence?,
 *       reached?, substate?, self_reported?, source? } -> 201 { recorded: true }
 * `correct` requires `question_id` to also be present (server-enforced,
 * 422 correct_requires_question_id otherwise) — this module does not
 * duplicate that check; its two real callers in host.js only ever set
 * `correct` alongside `questionId` together, from the same answered
 * record.
 *
 * substate/selfReported/source (confirmed the same way, against the same
 * file, migration 1787900000003): `substate` is one of 'confusion' /
 * 'overload' / 'unclear', or explicit `null` — never omitted when the
 * caller passed one, since omitting it would be indistinguishable from a
 * caller that never knew this field existed, and this module's whole job
 * is to say what was actually observed (or that nothing was). `self_
 * reported` is a boolean the server accepts ONLY alongside a real
 * (non-null) `substate` — 422 self_reported_requires_substate otherwise,
 * enforced at the DB level too — mirrored here so a caller mistake fails
 * the same way locally as it would against the server, not silently sent
 * and rejected. `source` is 'inline' or 'quiz', independent of the other
 * two — see host.js's own call sites for which value each one sends.
 *
 * NEVER sends a pseudonym field — confirmed the server derives it
 * server-side from the assignment's own salt and the authenticated
 * account (src/pseudonym/derive.js), and never reads one from the
 * request body at all. Nothing in this module's request-body
 * construction below includes that key, on purpose.
 *
 * TIMING: fire-and-forget, one POST per discrete signal, no batching.
 * This is a proposed resolution to a genuine ambiguity the brief flagged
 * explicitly (not guessed through) — see host.js's own header for the
 * full reasoning: it matches this codebase's own existing pattern for
 * every other outward call (fetchSummary/fetchQuestions are also
 * per-event), and a failed submit() must never visibly affect or block
 * the reading experience (CLAUDE.md invariant 8's "every failure
 * degrades to silence" spirit, extended here to a call that reports
 * OUT rather than reads IN).
 */

export function createOutcomesManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const outcomesUrl = opts.outcomesUrl; // full URL, assignmentId already baked in by the caller

  /* Returns { ok: true } or { ok: false, error }. `error` is the server's
   * own code when one came back (assignment_not_found, assignment_closed,
   * assignment_salt_unavailable, not_a_participant, invalid_paragraph_index,
   * correct_requires_question_id, invalid_confidence), or a client-side one
   * (invalid_paragraph_index, no_session, no_outcomes_url, network_error). */
  async function submit({
    paragraphIndex, struggled, questionId, correct, confidence, reached,
    substate, selfReported, source,
  } = {}) {
    if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) {
      return { ok: false, error: 'invalid_paragraph_index' };
    }
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) {
      return { ok: false, error: 'no_session' };
    }
    if (!outcomesUrl || !fetchImpl) return { ok: false, error: 'no_outcomes_url' };

    const body = { paragraph_index: paragraphIndex };
    if (typeof struggled === 'boolean') body.struggled = struggled;
    if (typeof questionId === 'string' && questionId) body.question_id = questionId;
    if (typeof correct === 'boolean') body.correct = correct;
    if (confidence === 'low' || confidence === 'high') body.confidence = confidence;
    if (typeof reached === 'boolean') body.reached = reached;

    // A real classification: sent as-is, and self_reported rides with it
    // ONLY here — never alongside a null/absent substate (matches the
    // server's own self_reported_requires_substate constraint). Explicit
    // null: sent as null, not omitted — see this file's own header for why
    // that distinction matters. undefined (the caller never mentioned
    // substate at all): neither branch below fires, so the key stays
    // absent entirely, identical to every caller that predates this field.
    if (substate === 'confusion' || substate === 'overload' || substate === 'unclear') {
      body.substate = substate;
      if (typeof selfReported === 'boolean') body.self_reported = selfReported;
    } else if (substate === null) {
      body.substate = null;
    }
    if (source === 'inline' || source === 'quiz') body.source = source;

    try {
      const resp = await fetchImpl(outcomesUrl, {
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
