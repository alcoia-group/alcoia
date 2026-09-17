/* explanation-events.js (item DC-2 follow-up). Field names and shape
 * (selectionType, paragraphIndex, logged, error codes) are copied from
 * reading alcoiaServer's src/http/routes/explanation-events.js directly,
 * the same way tests/kinematics.test.js's own header documents for that
 * sibling module. */
import { describe, it, expect, vi } from 'vitest';
import { createExplanationEventsManager } from '../alcoia/src/shared/explanation-events.js';

const EXPLANATION_EVENTS_URL = 'https://api.alcoia.invalid/api/assignments/a1/explanation-events';

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('submit — a successful explanation event', () => {
  it('POSTs selectionType, Bearer-authenticated', async () => {
    let seenUrl = null, seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url; seenInit = init;
      return { ok: true, json: async () => ({ logged: true }) };
    });
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });

    const result = await m.submit({ selectionType: 'equation' });
    expect(result).toEqual({ ok: true });
    expect(seenUrl).toBe(EXPLANATION_EVENTS_URL);
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seenInit.body)).toEqual({ selectionType: 'equation' });
  });

  it('includes a real non-negative integer paragraphIndex when given one', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ logged: true }) }; });
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ selectionType: 'figure', paragraphIndex: 4 });
    expect(seenBody).toEqual({ selectionType: 'figure', paragraphIndex: 4 });
  });

  it('omits paragraphIndex entirely when not given, not sent as null or undefined', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ logged: true }) }; });
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ selectionType: 'term' });
    expect(seenBody).not.toHaveProperty('paragraphIndex');
  });

  it('a negative or non-integer paragraphIndex is omitted, never sent as-is', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ logged: true }) }; });
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ selectionType: 'term', paragraphIndex: -1 });
    expect(seenBody).not.toHaveProperty('paragraphIndex');
    await m.submit({ selectionType: 'term', paragraphIndex: 2.5 });
    expect(seenBody).not.toHaveProperty('paragraphIndex');
  });

  it('never sends a pseudonym field — derived server-side only, same rule as outcomes.pseudonym', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ logged: true }) }; });
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ selectionType: 'caption' });
    expect(seenBody).not.toHaveProperty('pseudonym');
  });
});

describe('submit — validation and failure handling', () => {
  it('a missing or non-string selectionType is rejected before any network call', async () => {
    const fetchImpl = vi.fn();
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({})).toEqual({ ok: false, error: 'invalid_selection_type' });
    expect(await m.submit({ selectionType: 42 })).toEqual({ ok: false, error: 'invalid_selection_type' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf(null) });
    expect(await m.submit({ selectionType: 'equation' })).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a not_a_participant (403) response surfaces the server\'s own code', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'not_a_participant' }) }));
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ selectionType: 'equation' })).toEqual({ ok: false, error: 'not_a_participant' });
  });

  it('an invalid_selection_type (422) server response surfaces cleanly too', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: 'invalid_selection_type' }) }));
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ selectionType: 'equation' })).toEqual({ ok: false, error: 'invalid_selection_type' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createExplanationEventsManager({ fetchImpl, explanationEventsUrl: EXPLANATION_EVENTS_URL, getSession: sessionOf('tok-1') });
    await expect(m.submit({ selectionType: 'equation' })).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});
