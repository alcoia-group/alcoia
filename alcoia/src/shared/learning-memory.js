/* learning-memory.js -- the Account-based learning setting (client half)
 *
 * The SERVER is the only authority on whether account-based learning is on
 * (alcoiaServer src/learnerMemory/consent.js). This module keeps no consent
 * state of its own, in storage or in memory: every answer comes from the
 * server, so the setting can never show a state the server does not hold. It
 * never decides a scope version either: enable() echoes the version the
 * server reported in its own last answer, and the server rejects a mismatch.
 *
 * Same shape as billing.js/entitlements.js: injectable fetch and getSession,
 * never throws, every failure resolves to { ok: false, error } with the
 * server's own error code when it sent one.
 *
 * Four operations the learner can choose, kept strictly apart:
 *   disable()      stops use and writes, deletes nothing
 *   resetMemory()  permanently deletes the stored learning memory only
 *   exportMemory() downloads the stored learning memory (not account data)
 *   enable()       explicit acceptance of the current scope
 * Export and reset deliberately work whatever the consent state: consent
 * governs use of the memory, not the learner's right over what is stored.
 */
export const STATUSES = Object.freeze(['enabled', 'disabled']);

export function createLearningMemoryManager(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const getSession = opts.getSession;
  const baseUrl = opts.url;

  async function call(method, path, body) {
    const session = await getSession();
    if (!session || typeof session.token !== 'string' || !session.token) return { ok: false, error: 'no_session' };
    if (!baseUrl || !fetchImpl) return { ok: false, error: 'not_configured' };
    try {
      const headers = { Authorization: `Bearer ${session.token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const resp = await fetchImpl(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!resp.ok) return { ok: false, error: (data && typeof data.error === 'string' && data.error) || `status_${resp.status}`, data };
      return { ok: true, data, text };
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  function toState(data) {
    if (!data || !STATUSES.includes(data.status) || typeof data.currentScopeVersion !== 'number') return null;
    return {
      status: data.status,
      active: data.active === true && data.status === 'enabled',
      currentScopeVersion: data.currentScopeVersion,
      grantedAt: data.grantedAt ?? null,
      disabledAt: data.disabledAt ?? null,
    };
  }

  async function stateCall(method, path, body) {
    const r = await call(method, path, body);
    if (!r.ok) return r;
    const state = toState(r.data);
    return state ? { ok: true, state } : { ok: false, error: 'malformed_response' };
  }

  return {
    getState: () => stateCall('GET', ''),
    // scopeVersion must be the one the server reported (state.currentScopeVersion).
    enable: ({ scopeVersion }) => stateCall('POST', '/enable', { confirm: true, scopeVersion }),
    disable: () => stateCall('POST', '/disable', {}),
    async resetMemory() {
      const r = await call('DELETE', '');
      if (!r.ok) return r;
      return r.data && r.data.reset === true ? { ok: true } : { ok: false, error: 'malformed_response' };
    },
    // The file is exactly what the server sent (text), never rebuilt here.
    async exportMemory() {
      const r = await call('GET', '/export');
      if (!r.ok) return r;
      const day = new Date().toISOString().slice(0, 10);
      return { ok: true, text: r.text, filename: `alcoia-learning-memory-${day}.json` };
    },
  };
}
