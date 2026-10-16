/* teaching-focus.js: fetches which paragraphs of an ASSIGNED reading the instructor marked as
 * important (and the learner has not already shown they know).
 *
 *   GET {ASSIGNMENTS_URL}/:assignmentId/teaching-focus -> 200 { unitIds: [knowledgeUnitId, ...], units: [{ unitId, mode }], levelBias }
 *
 * Only hashes come back: no concept wording, no intent text. Same injectable, never-throws shape
 * as retention.js. Called once per session and only when there is an assignment, so ordinary
 * web pages never reach it. It can only change WHICH already-permitted moment gets a question;
 * every gate in the intervention policy still applies (see host.js checkFocusCandidate). */
export function createTeachingFocusManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const focusUrl = opts.focusUrl;

  async function getFocus() {
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) return { ok: false, error: 'no_session', unitIds: [], units: [], levelBias: null };
    if (!focusUrl || !fetchImpl) return { ok: false, error: 'no_focus_url', unitIds: [], units: [], levelBias: null };
    try {
      const resp = await fetchImpl(focusUrl, { method: 'GET', headers: { Authorization: `Bearer ${session.token}` } });
      if (!resp.ok) return { ok: false, error: `status_${resp.status}`, unitIds: [], units: [], levelBias: null };
      const data = await resp.json().catch(() => null);
      const unitIds = data && Array.isArray(data.unitIds) ? data.unitIds.filter((x) => typeof x === 'string' && x) : [];
      // `units` carries the mode per paragraph (normal | light | support | repair); an older server sends only unitIds,
      // which means a normal check for each.
      const MODES = ['normal', 'light', 'support', 'repair'];
      const units = data && Array.isArray(data.units)
        ? data.units.filter((u) => u && typeof u.unitId === 'string' && u.unitId).map((u) => ({ unitId: u.unitId, mode: MODES.includes(u.mode) ? u.mode : 'normal' }))
        : unitIds.map((unitId) => ({ unitId, mode: 'normal' }));
      // The instructor's depth as a bias on the question ladder: 'recall' caps it, 'application' prefers scenario once
      // the learner has earned free recall. A word only; the learner's own answers still earn each level.
      const levelBias = data && (data.levelBias === 'recall' || data.levelBias === 'application') ? data.levelBias : null;
      return { ok: true, unitIds: units.map((u) => u.unitId), units, levelBias };
    } catch (e) {
      return { ok: false, error: 'network_error', unitIds: [], units: [], levelBias: null };
    }
  }
  return { getFocus };
}
