/* outcomes.js — reporting a real reading signal against a specific
 * assignment (item S6/E4 follow-up). Field names asserted here
 * (paragraph_index, struggled, question_id, correct, confidence, reached,
 * substate, self_reported, source, recorded, the error codes) are copied
 * from reading alcoiaServer's src/http/routes/outcomes.js directly (13g).
 */
import { describe, it, expect, vi } from 'vitest';
import { createOutcomesManager } from '../alcoia/src/shared/outcomes.js';

const OUTCOMES_URL = 'https://api.alcoia.invalid/api/assignments/a1/outcomes';

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('submit — the request body NEVER carries a pseudonym', () => {
  it('a struggle signal POSTs only paragraph_index + struggled, no pseudonym key anywhere in the body', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ recorded: true }) };
    });
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });

    const result = await m.submit({ paragraphIndex: 3, struggled: true });
    expect(result).toEqual({ ok: true });
    expect(seenBody).toEqual({ paragraph_index: 3, struggled: true });
    expect(seenBody).not.toHaveProperty('pseudonym');
  });

  it('a question-answered signal POSTs paragraph_index + question_id + correct + confidence, still no pseudonym', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ recorded: true }) };
    });
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });

    await m.submit({ paragraphIndex: 5, questionId: 'q-abc', correct: true, confidence: 'high' });
    expect(seenBody).toEqual({ paragraph_index: 5, question_id: 'q-abc', correct: true, confidence: 'high' });
    expect(seenBody).not.toHaveProperty('pseudonym');
  });

  it('is Bearer-authenticated with the current session token', async () => {
    let seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => { seenInit = init; return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-xyz') });

    await m.submit({ paragraphIndex: 1, struggled: true });
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-xyz');
  });

  it('a correct: false answer is sent as an explicit false, never dropped as falsy', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });

    await m.submit({ paragraphIndex: 2, questionId: 'q-1', correct: false });
    expect(seenBody.correct).toBe(false);
  });

  it('correct: undefined (a model verdict of "unknown", or adversarial\'s deliberate non-grading) is omitted, not sent as null or false', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });

    await m.submit({ paragraphIndex: 2, questionId: 'q-1', correct: undefined });
    expect(seenBody).not.toHaveProperty('correct');
  });
});

/* 13g: substate/self_reported/source. Field names and the self_reported-
 * requires-substate pairing are copied from alcoiaServer's
 * src/http/routes/outcomes.js and migration 1787900000003 directly. */
describe('submit — substate / self_reported / source (13g)', () => {
  async function bodyFor(fields) {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });
    await m.submit(fields);
    return seenBody;
  }

  it('a real (self-reported) substate sends substate + self_reported:true together', async () => {
    const body = await bodyFor({ paragraphIndex: 3, struggled: true, substate: 'confusion', selfReported: true, source: 'inline' });
    expect(body).toEqual({ paragraph_index: 3, struggled: true, substate: 'confusion', self_reported: true, source: 'inline' });
  });

  it('a real (inferred) substate sends self_reported:false, distinctly from true', async () => {
    const body = await bodyFor({ paragraphIndex: 3, struggled: true, substate: 'overload', selfReported: false, source: 'inline' });
    expect(body.substate).toBe('overload');
    expect(body.self_reported).toBe(false);
  });

  it('accepts "unclear" as a real substate value too — this module mirrors the server\'s three-value set exactly, not just confusion/overload', async () => {
    const body = await bodyFor({ paragraphIndex: 3, struggled: true, substate: 'unclear', selfReported: false });
    expect(body.substate).toBe('unclear');
  });

  it('substate: null is sent as explicit null, never omitted and never fabricated as a guess', async () => {
    const body = await bodyFor({ paragraphIndex: 3, struggled: true, substate: null });
    expect(body).toHaveProperty('substate', null);
  });

  it('substate never mentioned at all (undefined) stays fully absent from the body — identical to every pre-13g caller', async () => {
    const body = await bodyFor({ paragraphIndex: 3, struggled: true });
    expect(body).not.toHaveProperty('substate');
    expect(body).not.toHaveProperty('self_reported');
  });

  it('self_reported is never sent alongside a null substate, even if a caller mistakenly passed one — mirrors the server\'s own constraint locally', async () => {
    const body = await bodyFor({ paragraphIndex: 3, struggled: true, substate: null, selfReported: true });
    expect(body).toHaveProperty('substate', null);
    expect(body).not.toHaveProperty('self_reported');
  });

  it('self_reported is never sent when substate was never mentioned at all, for the same reason', async () => {
    const body = await bodyFor({ paragraphIndex: 3, struggled: true, selfReported: true });
    expect(body).not.toHaveProperty('substate');
    expect(body).not.toHaveProperty('self_reported');
  });

  it('source: "inline" and "quiz" both pass through; anything else is silently dropped rather than sent unvalidated', async () => {
    expect((await bodyFor({ paragraphIndex: 1, source: 'inline' })).source).toBe('inline');
    expect((await bodyFor({ paragraphIndex: 1, source: 'quiz' })).source).toBe('quiz');
    expect(await bodyFor({ paragraphIndex: 1, source: 'bogus' })).not.toHaveProperty('source');
  });
});

describe('submit — validation and failure handling', () => {
  it('a non-integer or negative paragraphIndex is rejected before any network call', async () => {
    const fetchImpl = vi.fn();
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ paragraphIndex: null, struggled: true })).toEqual({ ok: false, error: 'invalid_paragraph_index' });
    expect(await m.submit({ paragraphIndex: -1, struggled: true })).toEqual({ ok: false, error: 'invalid_paragraph_index' });
    expect(await m.submit({ paragraphIndex: 1.5, struggled: true })).toEqual({ ok: false, error: 'invalid_paragraph_index' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf(null) });
    expect(await m.submit({ paragraphIndex: 1, struggled: true })).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an assignment_closed (422) response surfaces the server\'s own code', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: 'assignment_closed' }) }));
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ paragraphIndex: 1, struggled: true })).toEqual({ ok: false, error: 'assignment_closed' });
  });

  it('a not_a_participant (403) response surfaces cleanly', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'not_a_participant' }) }));
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ paragraphIndex: 1, struggled: true })).toEqual({ ok: false, error: 'not_a_participant' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createOutcomesManager({ fetchImpl, outcomesUrl: OUTCOMES_URL, getSession: sessionOf('tok-1') });
    await expect(m.submit({ paragraphIndex: 1, struggled: true })).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});
