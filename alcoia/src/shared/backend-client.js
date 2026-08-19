/* backend-client.js — acquires an install token, relays a POST through
 * background.js's apiPost proxy (item 43)
 *
 * Extracted from host.js's own inline callBackend(), which content.js's
 * fetchSummary()/fetchQuestions() already used this exact shape for. Pulled
 * out into src/shared/ so quiz.js — a normal extension page, not the
 * content-script context host.js is otherwise built for — can reach the new
 * grading endpoint without either duplicating the token/retry logic or
 * constructing a full host object it does not need the other eleven
 * callbacks of.
 *
 * Real ES module. host.js reaches it via loadModule() (dynamic import — the
 * same reason install-token.js itself is loaded that way, see that file's
 * header); quiz.js, already a real module context, imports it directly. Each
 * caller constructs its own instance, so the in-memory install-token state
 * install-token.js's own getToken() collapses per-instance stays exactly as
 * process-local as it always was — this file adds no shared state of its
 * own beyond that.
 */
import { createInstallTokenManager } from './install-token.js';

/* `getTokenUrl` is a function, called fresh on every callBackend() —
 * matching host.js's existing pattern of reading settings live rather than
 * capturing them once, since a reader can point the Backend URL setting at
 * a different server while a tab is already open. */
export function createBackendClient({ getTokenUrl, diagLog } = {}) {
  const resolveTokenUrl = typeof getTokenUrl === 'function' ? getTokenUrl : () => getTokenUrl;
  const installToken = createInstallTokenManager({ tokenUrl: resolveTokenUrl() });

  async function callBackend(action, url, body) {
    const token = await installToken.getToken(resolveTokenUrl());
    if (!token) { diagLog?.log(action, 'no_install_token'); return { ok: false, error: 'no_install_token' }; }
    return await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action, url, body, token }, (resp) => {
          if (chrome.runtime.lastError || !resp) { diagLog?.log(action, 'no_response'); resolve({ ok: false, error: 'no_response' }); return; }
          if (resp.tokenRejected) {
            installToken.invalidate();
            diagLog?.log(action, `token_rejected_${resp.status}`);
          } else if (!resp.ok) {
            diagLog?.log(action, resp.error || `status_${resp.status}`);
          }
          resolve(resp);
        });
      } catch (e) { diagLog?.log(action, String(e && e.message || e)); resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }

  return { callBackend, installToken };
}
