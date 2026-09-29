/* retention.js (intelligence-architecture audit, step 7). Field names and
 * shape (candidates: [{ knowledgeUnitId, retentionStage, nextRetrievalAt }])
 * mirror the response body src/http/routes/knowledge-state.js is built to
 * return — confirmed against that route directly, same discipline
 * tests/interventions.test.js's own header documents for its sibling
 * module. */
import { describe, it, expect, vi } from 'vitest';
import { createRetentionManager } from '../alcoia/src/shared/retention.js';

const DUE_URL = 'https://api.alcoia.invalid/api/knowledge-state/due';

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('getDue — a successful fetch', () => {
  it('GETs with Authorization: Bearer, no body', async () => {
    let seenUrl = null, seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url; seenInit = init;
      return { ok: true, json: async () => ({ candidates: [] }) };
    });
    const m = createRetentionManager({ fetchImpl, dueUrl: DUE_URL, getSession: sessionOf('tok-1') });

    const result = await m.getDue();
    expect(result.ok).toBe(true);
    expect(seenUrl).toBe(DUE_URL);
    expect(seenInit.method).toBe('GET');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
    expect(seenInit.body).toBeUndefined();
  });

  it('returns the real candidates array from the server', async () => {
    const candidates = [{ knowledgeUnitId: 'k5a20958613', retentionStage: 1, nextRetrievalAt: '2026-01-01T00:00:00.000Z' }];
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ candidates }) }));
    const m = createRetentionManager({ fetchImpl, dueUrl: DUE_URL, getSession: sessionOf('tok-1') });

    const result = await m.getDue();
    expect(result).toEqual({ ok: true, candidates });
  });

  it('returns an empty array, never throws, when the server sends a malformed body', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => null }));
    const m = createRetentionManager({ fetchImpl, dueUrl: DUE_URL, getSession: sessionOf('tok-1') });

    const result = await m.getDue();
    expect(result).toEqual({ ok: true, candidates: [] });
  });
});

describe('getDue — validation and failure handling', () => {
  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createRetentionManager({ fetchImpl, dueUrl: DUE_URL, getSession: sessionOf(null) });
    expect(await m.getDue()).toEqual({ ok: false, error: 'no_session', candidates: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an invalid_session (401) response surfaces the server\'s own code, empty candidates', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_session' }) }));
    const m = createRetentionManager({ fetchImpl, dueUrl: DUE_URL, getSession: sessionOf('tok-1') });
    expect(await m.getDue()).toEqual({ ok: false, error: 'invalid_session', candidates: [] });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createRetentionManager({ fetchImpl, dueUrl: DUE_URL, getSession: sessionOf('tok-1') });
    await expect(m.getDue()).resolves.toEqual({ ok: false, error: 'network_error', candidates: [] });
  });

  it('with no dueUrl configured, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createRetentionManager({ fetchImpl, getSession: sessionOf('tok-1') });
    expect(await m.getDue()).toEqual({ ok: false, error: 'no_due_url', candidates: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
