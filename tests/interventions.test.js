/* interventions.js (intelligence-architecture audit, step 5). Field names
 * and shape (intervention_id, knowledge_unit_id, paragraph_index, type,
 * recorded, error codes) mirror the request/response body
 * src/http/routes/interventions.js is built to accept on the server —
 * confirmed against that route directly, same discipline
 * tests/explanation-events.test.js's own header documents for its sibling
 * module. */
import { describe, it, expect, vi } from 'vitest';
import { createInterventionsManager } from '../alcoia/src/shared/interventions.js';

const INTERVENTIONS_URL = 'https://api.alcoia.invalid/api/assignments/a1/interventions';

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('submit — a successful intervention record', () => {
  it('POSTs intervention_id + type, Bearer-authenticated', async () => {
    let seenUrl = null, seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url; seenInit = init;
      return { ok: true, json: async () => ({ recorded: true }) };
    });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    const result = await m.submit({ interventionId: 'iv_1_abc', type: 'ask' });
    expect(result).toEqual({ ok: true });
    expect(seenUrl).toBe(INTERVENTIONS_URL);
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seenInit.body)).toEqual({ intervention_id: 'iv_1_abc', type: 'ask' });
  });

  it('includes knowledge_unit_id when given one', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'ask', knowledgeUnitId: 'k5a20958613' });
    expect(seenBody).toEqual({ intervention_id: 'iv_1', type: 'ask', knowledge_unit_id: 'k5a20958613' });
  });

  it('includes a real non-negative integer paragraph_index when given one', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'ask', paragraphIndex: 4 });
    expect(seenBody).toEqual({ intervention_id: 'iv_1', type: 'ask', paragraph_index: 4 });
  });

  it('omits knowledge_unit_id/paragraph_index entirely when not given, never sent as null or undefined', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'session_recall' });
    expect(seenBody).not.toHaveProperty('knowledge_unit_id');
    expect(seenBody).not.toHaveProperty('paragraph_index');
  });

  it('a negative or non-integer paragraphIndex is omitted, never sent as-is', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'ask', paragraphIndex: -1 });
    expect(seenBody).not.toHaveProperty('paragraph_index');
    await m.submit({ interventionId: 'iv_1', type: 'ask', paragraphIndex: 2.5 });
    expect(seenBody).not.toHaveProperty('paragraph_index');
  });

  it('never sends a pseudonym field or anything else account-linked — derived server-side only, same rule as outcomes.pseudonym', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'quiz' });
    expect(seenBody).not.toHaveProperty('pseudonym');
    expect(seenBody).not.toHaveProperty('accountId');
    expect(seenBody).not.toHaveProperty('email');
  });

  // Step 19 -- the real Content Intelligence trigger. `text` is the exact
  // bounded passage the caller already has at the point it calls submit();
  // this module never fetches, truncates, or otherwise touches it beyond
  // forwarding it as-is.
  it('includes text when given one, the exact bounded passage already in hand', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'ask', knowledgeUnitId: 'k5a20958613', text: 'The exact paragraph the reader struggled with.' });
    expect(seenBody).toEqual({
      intervention_id: 'iv_1', type: 'ask', knowledge_unit_id: 'k5a20958613',
      text: 'The exact paragraph the reader struggled with.',
    });
  });

  it('omits text entirely when not given, never sent as null/undefined/empty string', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'retention' });
    expect(seenBody).not.toHaveProperty('text');

    await m.submit({ interventionId: 'iv_1', type: 'retention', text: '' });
    expect(seenBody).not.toHaveProperty('text');

    await m.submit({ interventionId: 'iv_1', type: 'retention', text: null });
    expect(seenBody).not.toHaveProperty('text');
  });

  it('a non-string text is omitted, never sent as-is', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ interventionId: 'iv_1', type: 'ask', text: 12345 });
    expect(seenBody).not.toHaveProperty('text');
  });
});

describe('submit — validation and failure handling', () => {
  it('a missing or non-string interventionId is rejected before any network call', async () => {
    const fetchImpl = vi.fn();
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ type: 'ask' })).toEqual({ ok: false, error: 'invalid_intervention_id' });
    expect(await m.submit({ interventionId: 42, type: 'ask' })).toEqual({ ok: false, error: 'invalid_intervention_id' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a missing or non-string type is rejected before any network call', async () => {
    const fetchImpl = vi.fn();
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ interventionId: 'iv_1' })).toEqual({ ok: false, error: 'invalid_type' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf(null) });
    expect(await m.submit({ interventionId: 'iv_1', type: 'ask' })).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a not_a_participant (403) response surfaces the server\'s own code', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'not_a_participant' }) }));
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ interventionId: 'iv_1', type: 'ask' })).toEqual({ ok: false, error: 'not_a_participant' });
  });

  it('an invalid_type (422) server response surfaces cleanly too', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: 'invalid_type' }) }));
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ interventionId: 'iv_1', type: 'ask' })).toEqual({ ok: false, error: 'invalid_type' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createInterventionsManager({ fetchImpl, interventionsUrl: INTERVENTIONS_URL, getSession: sessionOf('tok-1') });
    await expect(m.submit({ interventionId: 'iv_1', type: 'ask' })).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});
