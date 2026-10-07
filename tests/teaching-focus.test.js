import { describe, it, expect, vi } from 'vitest';
import { createTeachingFocusManager } from '../alcoia/src/shared/teaching-focus.js';

const URL_ = 'https://api.alcoia.invalid/api/assignments/a1/teaching-focus';
const session = (t) => async () => (t ? { token: t } : null);

describe('getFocus', () => {
  it('GETs with Bearer and returns only string ids', async () => {
    let init;
    const fetchImpl = vi.fn(async (u, i) => { init = i; return { ok: true, json: async () => ({ unitIds: ['k1', 5, '', 'k2'] }) }; });
    const r = await createTeachingFocusManager({ fetchImpl, focusUrl: URL_, getSession: session('t') }).getFocus();
    expect(r).toEqual({ ok: true, unitIds: ['k1', 'k2'] });
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer t');
  });
  it('fails open with an empty list: no session, bad status, network error', async () => {
    expect((await createTeachingFocusManager({ fetchImpl: vi.fn(), focusUrl: URL_, getSession: session(null) }).getFocus()).unitIds).toEqual([]);
    expect((await createTeachingFocusManager({ fetchImpl: async () => ({ ok: false, status: 403 }), focusUrl: URL_, getSession: session('t') }).getFocus())).toMatchObject({ ok: false, unitIds: [] });
    expect((await createTeachingFocusManager({ fetchImpl: async () => { throw new Error('x'); }, focusUrl: URL_, getSession: session('t') }).getFocus())).toMatchObject({ ok: false, error: 'network_error', unitIds: [] });
  });
});
