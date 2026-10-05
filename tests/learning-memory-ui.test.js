// @vitest-environment jsdom
/* The Account-based learning card, loaded from the REAL settings.html so the
 * test cannot drift from the markup that ships. The manager is a fake server
 * with the same behaviour as alcoiaServer's consent routes. */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountLearningMemory } from '../alcoia/src/popup/learning-memory-ui.js';
import { createLearningMemoryManager } from '../alcoia/src/shared/learning-memory.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, '..', 'alcoia', 'src', 'popup', 'settings.html'), 'utf8');
const card = html.match(/<div class="settings-card" id="learningMemory"[\s\S]*?\n  <\/div>\n\n/)[0];
const SCOPE = 4;

// A stand-in for the server: the only holder of consent state.
function fakeServer({ status = 'never_enabled', memoryRows = 2, failNext = null } = {}) {
  const s = { status, memoryRows, calls: [], scope: SCOPE, failNext };
  const view = () => ({
    status: s.status, active: s.status === 'enabled', currentScopeVersion: s.scope,
    acceptedScopeVersion: s.status === 'never_enabled' ? null : s.scope, grantedAt: null, disabledAt: null, updatedAt: null,
  });
  s.fetchImpl = async (url, init) => {
    const route = `${init.method} ${url.replace('https://server.test/api/account/learning-memory', '') || '/'}`;
    s.calls.push({ route, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status2, body) => ({ ok: status2 < 300, status: status2, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (s.failNext && route.startsWith(s.failNext)) { s.failNext = null; return reply(500, { error: 'internal_error' }); }
    if (route === 'GET /') return reply(200, view());
    if (route === 'POST /enable') {
      const b = JSON.parse(init.body);
      if (b.confirm !== true) return reply(422, { error: 'confirmation_required' });
      if (b.scopeVersion !== s.scope) return reply(409, { error: 'scope_version_mismatch' });
      s.status = 'enabled';
      return reply(200, view());
    }
    if (route === 'POST /disable') { if (s.status !== 'never_enabled') s.status = 'disabled'; return reply(200, view()); }
    if (route === 'DELETE /') { const n = s.memoryRows; s.memoryRows = 0; return reply(200, { reset: true, deleted: { knowledge_state: n } }); }
    if (route === 'GET /export') return reply(200, JSON.stringify({ knowledgeState: new Array(s.memoryRows).fill({}) }));
    return reply(404, { error: 'not_found' });
  };
  return s;
}

let saved;
async function setup(opts = {}, session = { token: 't', email: 'a@example.com' }) {
  document.body.innerHTML = card;
  const server = fakeServer(opts);
  saved = [];
  const root = document.getElementById('learningMemory');
  const ui = mountLearningMemory({
    root,
    manager: createLearningMemoryManager({ fetchImpl: server.fetchImpl, getSession: async () => session, url: 'https://server.test/api/account/learning-memory' }),
    saveFile: (name, text) => saved.push({ name, text }),
  });
  await ui.refresh();
  const q = (k) => root.querySelector(`[data-lm="${k}"]`);
  const click = async (k) => { q(k).click(); await new Promise((r) => setTimeout(r, 0)); };
  return { server, ui, q, click, root };
}

describe('Account-based learning card', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('explains the choice up front: optional, purpose, not surveillance, who can see it', () => {
    const text = card.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/This is optional\. Alcoia works without it/);
    expect(text).toMatch(/not used by Alcoia for advertising, sold to third parties, or used to build profiles about you for unrelated purposes/);
    expect(text).toMatch(/learning state, not a surveillance history of your reading/);
    expect(text).toMatch(/instructors cannot see it as your private learning memory/);
    expect(text).toMatch(/some class features may use aggregated learning information/);
    expect(text).not.toMatch(/Cross-document|analytics|Exam Mode|upgrade|premium|unlock/i);
  });

  it('shows Off for never enabled, with no implication memory exists', async () => {
    const { q } = await setup({ status: 'never_enabled' });
    expect(q('state-label').textContent).toBe('Off');
    expect(q('state-detail').textContent).toMatch(/not remembering anything/);
    expect(q('toggle').getAttribute('aria-checked')).toBe('false');
    expect(q('toggle').getAttribute('role')).toBe('switch');
  });

  it('shows On when current, with the switch exposed to assistive technology', async () => {
    const { q } = await setup({ status: 'enabled' });
    expect(q('state-label').textContent).toBe('On');
    expect(q('toggle').getAttribute('aria-checked')).toBe('true');
    expect(q('toggle').textContent).toBe('Turn off');
  });

  it('disabled: Off, says earlier memory is kept, and allows export and delete', async () => {
    const { q } = await setup({ status: 'disabled' });
    expect(q('state-label').textContent).toBe('Off');
    expect(q('state-detail').textContent).toMatch(/kept until you delete it/);
    expect(q('export').disabled).toBe(false);
    expect(q('delete-open').disabled).toBe(false);
  });

  it('reconsent required: inactive, says the scope changed, and does not reactivate on its own', async () => {
    const { q, server } = await setup({ status: 'reconsent_required' });
    expect(q('state-detail').textContent).toMatch(/Inactive.*changed.*Turn it on again/);
    expect(q('toggle').getAttribute('aria-checked')).toBe('false');
    expect(server.calls.map((c) => c.route)).toEqual(['GET /']);
  });

  it('turning on needs an explicit confirmation: clicking the switch alone enables nothing', async () => {
    const { q, click, server } = await setup({ status: 'never_enabled' });
    await click('toggle');
    expect(q('enable-panel').hidden).toBe(false);
    expect(server.calls.map((c) => c.route)).toEqual(['GET /']);
    await click('enable-cancel');
    expect(q('enable-panel').hidden).toBe(true);
    expect(server.status).toBe('never_enabled');
    expect(server.calls.map((c) => c.route)).toEqual(['GET /']);
  });

  it('confirming enables with confirm:true and the scope version the server reported', async () => {
    const { q, click, server } = await setup({ status: 'never_enabled' });
    await click('toggle');
    await click('enable-confirm');
    const call = server.calls.find((c) => c.route === 'POST /enable');
    expect(call.body).toEqual({ confirm: true, scopeVersion: SCOPE });
    expect(q('state-label').textContent).toBe('On');
  });

  it('works the same for Free, Reader and Student accounts (no plan is read or sent)', async () => {
    for (const plan of [undefined, 'reader', 'student']) {
      const { q, click, server } = await setup({}, { token: 't', email: 'a@example.com', plan });
      await click('toggle');
      await click('enable-confirm');
      expect(q('state-label').textContent).toBe('On');
      expect(JSON.stringify(server.calls)).not.toMatch(/plan|features|accountId|account_id/);
    }
  });

  it('disable calls only disable and deletes nothing', async () => {
    const { q, click, server } = await setup({ status: 'enabled', memoryRows: 3 });
    await click('toggle');
    expect(server.calls.map((c) => c.route)).toEqual(['GET /', 'POST /disable']);
    expect(server.memoryRows).toBe(3);
    expect(q('state-label').textContent).toBe('Off');
    expect(document.body.textContent).toMatch(/Nothing was deleted/);
  });

  it('delete is a separate, explicit, destructive step that does not change the setting', async () => {
    const { q, click, server } = await setup({ status: 'enabled', memoryRows: 3 });
    await click('delete-open');
    expect(q('delete-panel').hidden).toBe(false);
    expect(q('delete-panel').textContent).toMatch(/cannot be undone/);
    expect(q('delete-panel').textContent).toMatch(/does not delete your Alcoia account, class membership, billing information/);
    expect(server.calls.some((c) => c.route === 'DELETE /')).toBe(false);
    await click('delete-confirm');
    expect(server.memoryRows).toBe(0);
    expect(server.calls.filter((c) => c.route === 'POST /disable')).toHaveLength(0);
    expect(server.status).toBe('enabled');
    expect(q('state-label').textContent).toBe('On');
  });

  it('delete with nothing stored still reports success', async () => {
    const { q, click } = await setup({ status: 'disabled', memoryRows: 0 });
    await click('delete-open');
    await click('delete-confirm');
    expect(document.body.textContent).toMatch(/learning memory was deleted/);
    expect(q('state-label').textContent).toBe('Off');
  });

  it('cancelling delete deletes nothing', async () => {
    const { click, server } = await setup({ status: 'enabled', memoryRows: 2 });
    await click('delete-open');
    await click('delete-cancel');
    expect(server.memoryRows).toBe(2);
  });

  it('export saves exactly what the server returned', async () => {
    const { click } = await setup({ status: 'disabled', memoryRows: 2 });
    await click('export');
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(/^alcoia-learning-memory-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(saved[0].text).knowledgeState).toHaveLength(2);
  });

  it('a failed enable leaves the UI on the server-confirmed Off state and says so', async () => {
    const { q, click, server } = await setup({ status: 'never_enabled', failNext: 'POST /enable' });
    await click('toggle');
    await click('enable-confirm');
    expect(q('state-label').textContent).toBe('Off');
    expect(server.status).toBe('never_enabled');
    expect(q('message').textContent).toMatch(/Nothing was changed/);
    expect(q('message').getAttribute('role')).toBe('alert');
  });

  it('a failed disable keeps showing On', async () => {
    const { q, click } = await setup({ status: 'enabled', failNext: 'POST /disable' });
    await click('toggle');
    expect(q('state-label').textContent).toBe('On');
    expect(q('message').getAttribute('role')).toBe('alert');
  });

  it('a failed delete does not claim success', async () => {
    const { q, click, server } = await setup({ status: 'enabled', memoryRows: 2, failNext: 'DELETE /' });
    await click('delete-open');
    await click('delete-confirm');
    expect(server.memoryRows).toBe(2);
    expect(q('message').textContent).toMatch(/Nothing was changed/);
  });

  it('a scope-version mismatch refreshes the description and does not enable', async () => {
    const { q, click, server } = await setup({ status: 'never_enabled' });
    server.scope = SCOPE + 1; // the server's scope moved after the page loaded
    await click('toggle');
    await click('enable-confirm');
    expect(server.status).toBe('never_enabled');
    expect(q('message').textContent).toMatch(/description changed/);
  });

  it('destructive and ordinary actions are distinct, labelled buttons reachable by keyboard', async () => {
    const { q } = await setup({ status: 'enabled' });
    for (const k of ['toggle', 'export', 'delete-open']) expect(q(k).tagName).toBe('BUTTON');
    expect(q('toggle').textContent).not.toMatch(/delete/i);
    expect(q('delete-open').textContent).toBe('Delete learning memory');
    expect(q('export').textContent).toBe('Export learning memory');
  });
});
