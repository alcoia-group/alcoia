/* invites.js — accepting a class invite, releasing a seat (item S6). Field
 * names asserted here (token, classId, seatId, role, released, the error
 * codes) are copied from reading alcoiaServer's src/http/routes/invites.js
 * and seats.js directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInvitesManager } from '../alcoia/src/shared/invites.js';

const ACCEPT_URL = 'https://api.alcoia.invalid/api/invites/accept';
const SEATS_URL = 'https://api.alcoia.invalid/api/seats';

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('acceptInvite', () => {
  it('a bare code POSTs { token } as-is, Bearer-authenticated, and returns the confirmed fields', async () => {
    let seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenInit = init;
      return { ok: true, json: async () => ({ classId: 'class-1', seatId: 'seat-1', role: 'student' }) };
    });
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });

    const result = await m.acceptInvite('abc123code');
    expect(result).toEqual({ ok: true, classId: 'class-1', seatId: 'seat-1', role: 'student' });
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seenInit.body)).toEqual({ token: 'abc123code' });
  });

  it('a full link with ?token=... has the token extracted before sending', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ classId: 'class-1', seatId: 'seat-1', role: 'student' }) };
    });
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });

    await m.acceptInvite('https://alcoia.app/join?token=xyz789&other=1');
    expect(seenBody).toEqual({ token: 'xyz789' });
  });

  it('a full link with ?code=... (the other common name) also has it extracted', async () => {
    let seenBody = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ classId: 'c', seatId: 's', role: 'student' }) };
    });
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });

    await m.acceptInvite('https://alcoia.app/join?code=qed456');
    expect(seenBody).toEqual({ token: 'qed456' });
  });

  it('an empty or whitespace-only input is rejected before any network call', async () => {
    const fetchImpl = vi.fn();
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('')).toEqual({ ok: false, error: 'no_token' });
    expect(await m.acceptInvite('   ')).toEqual({ ok: false, error: 'no_token' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf(null) });
    expect(await m.acceptInvite('some-code')).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('acceptInvite — an invalid or expired invite fails cleanly', () => {
  it('an unrecognised code surfaces the server\'s own invalid_invite (404)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'invalid_invite' }) }));
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('bogus')).toEqual({ ok: false, error: 'invalid_invite' });
  });

  it('a revoked invite surfaces invite_revoked (410)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 410, json: async () => ({ error: 'invite_revoked' }) }));
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('revoked-code')).toEqual({ ok: false, error: 'invite_revoked' });
  });

  it('an expired invite surfaces invite_expired (410)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 410, json: async () => ({ error: 'invite_expired' }) }));
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('expired-code')).toEqual({ ok: false, error: 'invite_expired' });
  });

  it('a domain-mode mismatch surfaces domain_mismatch (403)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'domain_mismatch' }) }));
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('domain-code')).toEqual({ ok: false, error: 'domain_mismatch' });
  });

  it('an already-consumed invite surfaces invite_full (409)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'invite_full' }) }));
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('full-code')).toEqual({ ok: false, error: 'invite_full' });
  });

  it('already being a member surfaces already_a_member (409), not treated as success', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'already_a_member' }) }));
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('c')).toEqual({ ok: false, error: 'already_a_member' });
  });

  it('a malformed success response (missing seatId) is rejected, not trusted', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ classId: 'c' }) }));
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    expect(await m.acceptInvite('c')).toEqual({ ok: false, error: 'malformed_response' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createInvitesManager({ fetchImpl, acceptUrl: ACCEPT_URL, getSession: sessionOf('tok-1') });
    await expect(m.acceptInvite('c')).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});

describe('releaseSeat', () => {
  it('POSTs to /:id/release with Bearer auth and returns ok on { released: true }', async () => {
    let seenUrl = null;
    let seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url; seenInit = init;
      return { ok: true, json: async () => ({ released: true }) };
    });
    const m = createInvitesManager({ fetchImpl, seatsUrl: SEATS_URL, getSession: sessionOf('tok-1') });

    expect(await m.releaseSeat('seat-42')).toEqual({ ok: true });
    expect(seenUrl).toBe('https://api.alcoia.invalid/api/seats/seat-42/release');
    expect(seenInit.method).toBe('POST');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
  });

  it('with no seatId, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createInvitesManager({ fetchImpl, seatsUrl: SEATS_URL, getSession: sessionOf('tok-1') });
    expect(await m.releaseSeat('')).toEqual({ ok: false, error: 'no_seat_id' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createInvitesManager({ fetchImpl, seatsUrl: SEATS_URL, getSession: sessionOf(null) });
    expect(await m.releaseSeat('seat-1')).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a 404 seat_not_found surfaces the server\'s own code', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'seat_not_found' }) }));
    const m = createInvitesManager({ fetchImpl, seatsUrl: SEATS_URL, getSession: sessionOf('tok-1') });
    expect(await m.releaseSeat('gone')).toEqual({ ok: false, error: 'seat_not_found' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    const m = createInvitesManager({ fetchImpl, seatsUrl: SEATS_URL, getSession: sessionOf('tok-1') });
    await expect(m.releaseSeat('seat-1')).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});
