/* kinematics.js — reporting a session's scroll-kinematics summary (item
 * DC-1a). Field names and shape (assignmentId, kinematics, collectionLabel,
 * recorded, error codes) are copied from reading alcoiaServer's
 * src/http/routes/scroll-sessions.js directly, the same way
 * tests/outcomes.test.js's own header documents for that sibling module. */
import { describe, it, expect, vi } from 'vitest';
import { createKinematicsManager, shouldSubmitKinematics, MIN_SESSION_MS } from '../alcoia/src/shared/kinematics.js';

const KINEMATICS_URL = 'https://api.alcoia.invalid/api/sessions/kinematics';
const ASSIGNMENT_ID = '44444444-4444-4444-4444-444444444444';

const VALID_KINEMATICS = {
  duration_ms: 45230,
  scroll_events: 128,
  velocity_p50: 0.42,
  velocity_p95: 1.8,
  velocity_variance: 0.06,
  jitter_score: 0.11,
  micro_correction_count: 7,
  micro_correction_rate: 0.0547,
  acceleration_events: 4,
  direction_changes: 12,
  smooth_scroll_ratio: 0.83,
};

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('submit — a signed-in session of sufficient length', () => {
  it('POSTs assignmentId + kinematics, Bearer-authenticated, with keepalive:true', async () => {
    let seenUrl = null, seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url; seenInit = init;
      return { ok: true, json: async () => ({ recorded: true }) };
    });
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });

    const result = await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS });
    expect(result).toEqual({ ok: true });
    expect(seenUrl).toBe(KINEMATICS_URL);
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
    expect(seenInit.keepalive).toBe(true);
    expect(JSON.parse(seenInit.body)).toEqual({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS });
  });

  it('never sends a pseudonym field — derived server-side only, same rule as outcomes.pseudonym', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS });
    expect(seenBody).not.toHaveProperty('pseudonym');
  });

  it('an accepted collectionLabel rides along; an unmentioned one stays absent (server defaults it)', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => { seenBody = JSON.parse(init.body); return { ok: true, json: async () => ({ recorded: true }) }; });
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });

    await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS, collectionLabel: 'baseline_v2' });
    expect(seenBody.collectionLabel).toBe('baseline_v2');

    await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS });
    expect(seenBody).not.toHaveProperty('collectionLabel');
  });
});

describe('submit — a non-signed-in user sends nothing', () => {
  it('with no session, never calls fetch, and reports no_session', async () => {
    const fetchImpl = vi.fn();
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf(null) });
    expect(await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS })).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('submit — validation, before any network call', () => {
  it('rejects a missing or non-string assignmentId', async () => {
    const fetchImpl = vi.fn();
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ kinematics: VALID_KINEMATICS })).toEqual({ ok: false, error: 'invalid_assignment_id' });
    expect(await m.submit({ assignmentId: 123, kinematics: VALID_KINEMATICS })).toEqual({ ok: false, error: 'invalid_assignment_id' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-object kinematics payload', async () => {
    const fetchImpl = vi.fn();
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ assignmentId: ASSIGNMENT_ID })).toEqual({ ok: false, error: 'invalid_kinematics' });
    expect(await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: 'nope' })).toEqual({ ok: false, error: 'invalid_kinematics' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('submit — a failed POST does not surface any error and does not throw', () => {
  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });
    await expect(m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS })).resolves.toEqual({ ok: false, error: 'network_error' });
  });

  it('a not_a_participant (403) response surfaces the server\'s own code, not a thrown error', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'not_a_participant' }) }));
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS })).toEqual({ ok: false, error: 'not_a_participant' });
  });

  it('an invalid_kinematics (422) response surfaces cleanly', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: 'invalid_kinematics' }) }));
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS })).toEqual({ ok: false, error: 'invalid_kinematics' });
  });

  it('a response body that fails to parse as JSON still resolves, not throws', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }));
    const m = createKinematicsManager({ fetchImpl, kinematicsUrl: KINEMATICS_URL, getSession: sessionOf('tok-1') });
    expect(await m.submit({ assignmentId: ASSIGNMENT_ID, kinematics: VALID_KINEMATICS })).toEqual({ ok: false, error: 'status_500' });
  });
});

/* content.js's and viewer.js's shared beforeunload gate — see kinematics.js's
 * own header for why this is a standalone predicate rather than inlined
 * separately at each call site. */
describe('shouldSubmitKinematics — the 30s-session / has-a-summary gate', () => {
  it('is exactly 30 seconds (this item\'s own brief number)', () => {
    expect(MIN_SESSION_MS).toBe(30000);
  });

  it('a session shorter than 30 seconds sends nothing, even with a real kinematics summary', () => {
    expect(shouldSubmitKinematics({ durationMs: 29999, kinematics: VALID_KINEMATICS })).toBe(false);
    expect(shouldSubmitKinematics({ durationMs: 100, kinematics: VALID_KINEMATICS })).toBe(false);
  });

  it('a session of at least 30 seconds with a real summary is eligible', () => {
    expect(shouldSubmitKinematics({ durationMs: 30000, kinematics: VALID_KINEMATICS })).toBe(true);
    expect(shouldSubmitKinematics({ durationMs: 45230, kinematics: VALID_KINEMATICS })).toBe(true);
  });

  it('no kinematics summary (too little scroll history) sends nothing, regardless of duration', () => {
    expect(shouldSubmitKinematics({ durationMs: 999999, kinematics: null })).toBe(false);
    expect(shouldSubmitKinematics({ durationMs: 999999, kinematics: undefined })).toBe(false);
  });
});
