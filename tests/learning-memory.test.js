import { describe, it, expect } from 'vitest';
import { createLearningMemoryManager } from '../alcoia/src/shared/learning-memory.js';

const URL_BASE = 'https://server.test/api/account/learning-memory';
const SESSION = { token: 'tok-1', email: 'a@example.com' };

function server(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const { status = 200, body } = handler(url, init, calls.length);
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { calls, fetchImpl };
}
const mgr = (fetchImpl, session = SESSION) =>
  createLearningMemoryManager({ fetchImpl, getSession: async () => session, url: URL_BASE });
const view = (status, extra = {}) => ({
  status, active: status === 'enabled', currentScopeVersion: 3, acceptedScopeVersion: 3,
  grantedAt: null, disabledAt: null, updatedAt: null, ...extra,
});

describe('learning-memory manager', () => {
  it('reads the server state for every status and keeps none itself', async () => {
    for (const status of ['enabled', 'disabled']) {
      const { fetchImpl, calls } = server(() => ({ body: view(status) }));
      const r = await mgr(fetchImpl).getState();
      expect(r.ok).toBe(true);
      expect(r.state.status).toBe(status);
      expect(r.state.active).toBe(status === 'enabled');
      expect(calls[0]).toMatchObject({ url: URL_BASE, method: 'GET' });
      expect(calls[0].headers.Authorization).toBe('Bearer tok-1');
    }
  });

  it('a state it does not recognise is an error, never a guessed state', async () => {
    const { fetchImpl } = server(() => ({ body: { status: 'premium', currentScopeVersion: 1 } }));
    expect(await mgr(fetchImpl).getState()).toMatchObject({ ok: false, error: 'malformed_response' });
  });

  it('enable posts an explicit confirmation and the version the server reported, nothing else', async () => {
    const { fetchImpl, calls } = server(() => ({ body: view('enabled') }));
    const r = await mgr(fetchImpl).enable({ scopeVersion: 3 });
    expect(r.state.status).toBe('enabled');
    expect(calls[0]).toMatchObject({ url: `${URL_BASE}/enable`, method: 'POST' });
    expect(JSON.parse(calls[0].body)).toEqual({ confirm: true, scopeVersion: 3 });
  });

  it('disable only calls disable, and sends no account id, plan or features', async () => {
    const { fetchImpl, calls } = server(() => ({ body: view('disabled') }));
    await mgr(fetchImpl).disable();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${URL_BASE}/disable`);
    expect(JSON.parse(calls[0].body)).toEqual({});
  });

  it('reset calls DELETE on the learning-memory resource only and does not touch consent', async () => {
    const { fetchImpl, calls } = server(() => ({ body: { reset: true, deleted: { knowledge_state: 0 } } }));
    expect(await mgr(fetchImpl).resetMemory()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: URL_BASE, method: 'DELETE' });
  });

  it('export returns the server text byte for byte, with a dated file name', async () => {
    const raw = '{"format":"alcoia-learning-memory-export-v1",  "knowledgeState":[]}';
    const { fetchImpl, calls } = server(() => ({ body: raw }));
    const r = await mgr(fetchImpl).exportMemory();
    expect(r.text).toBe(raw);
    expect(r.filename).toMatch(/^alcoia-learning-memory-\d{4}-\d{2}-\d{2}\.json$/);
    expect(calls[0].url).toBe(`${URL_BASE}/export`);
  });

  it('surfaces server error codes and network failures, never throws', async () => {
    const { fetchImpl } = server(() => ({ status: 409, body: { error: 'scope_version_mismatch' } }));
    expect(await mgr(fetchImpl).enable({ scopeVersion: 1 })).toMatchObject({ ok: false, error: 'scope_version_mismatch' });
    const boom = async () => { throw new Error('offline'); };
    expect(await mgr(boom).getState()).toMatchObject({ ok: false, error: 'network_error' });
  });

  it('without a session it makes no request', async () => {
    const { fetchImpl, calls } = server(() => ({ body: view('enabled') }));
    for (const op of ['getState', 'disable', 'resetMemory', 'exportMemory']) {
      expect(await mgr(fetchImpl, null)[op]()).toMatchObject({ ok: false, error: 'no_session' });
    }
    expect(calls).toHaveLength(0);
  });
});
