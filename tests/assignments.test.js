/* assignments.js — a signed-in student's own assignments (item S6/E4
 * follow-up). Field names asserted here (assignmentId, classId, className,
 * closesAt, documents[], documentId, format, status, url,
 * expiresInSeconds) are copied from reading alcoiaServer's
 * src/http/routes/assignments.js and documents.js directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAssignmentsManager } from '../alcoia/src/shared/assignments.js';

const MINE_URL = 'https://api.alcoia.invalid/api/assignments/mine';
const DOCUMENTS_URL = 'https://api.alcoia.invalid/api/documents';

function sessionOf(token) {
  return async () => (token ? { token, email: 'reader@example.com', expiresAt: Date.now() + 999_999 } : null);
}

describe('listMine', () => {
  it('GETs with Bearer auth and returns the confirmed shape verbatim', async () => {
    let seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenInit = init;
      return {
        ok: true,
        json: async () => ({
          assignments: [{
            assignmentId: 'a1', classId: 'c1', className: 'Reading 101', closesAt: '2099-01-01T00:00:00Z',
            documents: [{ documentId: 'd1', format: 'pdf', status: 'accepted' }],
          }],
        }),
      };
    });
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf('tok-1') });

    const result = await m.listMine();
    expect(result).toEqual({
      ok: true,
      assignments: [{
        assignmentId: 'a1', classId: 'c1', className: 'Reading 101', closesAt: '2099-01-01T00:00:00Z',
        documents: [{ documentId: 'd1', format: 'pdf', status: 'accepted' }],
      }],
    });
    expect(seenInit.method).toBe('GET');
    expect(seenInit.headers.Authorization).toBe('Bearer tok-1');
  });

  it('a student with no assignments gets an empty array, not an error', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ assignments: [] }) }));
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf('tok-1') });
    expect(await m.listMine()).toEqual({ ok: true, assignments: [] });
  });

  it('an assignment with zero documents keeps an empty documents array, not fabricated', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ assignments: [{ assignmentId: 'a1', classId: 'c1', className: 'X', closesAt: '2099-01-01T00:00:00Z', documents: [] }] }),
    }));
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf('tok-1') });
    const result = await m.listMine();
    expect(result.assignments[0].documents).toEqual([]);
  });

  it('an assignment with more than one document (a re-upload) keeps all of them', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        assignments: [{
          assignmentId: 'a1', classId: 'c1', className: 'X', closesAt: '2099-01-01T00:00:00Z',
          documents: [
            { documentId: 'd1', format: 'pdf', status: 'accepted' },
            { documentId: 'd2', format: 'pdf', status: 'accepted' },
          ],
        }],
      }),
    }));
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf('tok-1') });
    const result = await m.listMine();
    expect(result.assignments[0].documents).toHaveLength(2);
  });

  it('an unviewable document (pptx, unsupported) is reported honestly, not filtered out or relabelled', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        assignments: [{
          assignmentId: 'a1', classId: 'c1', className: 'X', closesAt: '2099-01-01T00:00:00Z',
          documents: [{ documentId: 'd1', format: 'pptx', status: 'unsupported' }],
        }],
      }),
    }));
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf('tok-1') });
    const result = await m.listMine();
    expect(result.assignments[0].documents).toEqual([{ documentId: 'd1', format: 'pptx', status: 'unsupported' }]);
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf(null) });
    expect(await m.listMine()).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a malformed response (assignments not an array) is rejected, not trusted', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ nope: true }) }));
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf('tok-1') });
    expect(await m.listMine()).toEqual({ ok: false, error: 'malformed_response' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const m = createAssignmentsManager({ fetchImpl, mineUrl: MINE_URL, getSession: sessionOf('tok-1') });
    await expect(m.listMine()).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});

describe('getDownloadUrl', () => {
  it('GETs /:id/download-url with Bearer auth and returns a fresh signed URL', async () => {
    let seenUrl = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url;
      expect(init.headers.Authorization).toBe('Bearer tok-1');
      return { ok: true, json: async () => ({ url: 'https://storage.example/signed?sig=abc', expiresInSeconds: 900 }) };
    });
    const m = createAssignmentsManager({ fetchImpl, documentsUrl: DOCUMENTS_URL, getSession: sessionOf('tok-1') });

    const result = await m.getDownloadUrl('doc-1');
    expect(result).toEqual({ ok: true, url: 'https://storage.example/signed?sig=abc', expiresInSeconds: 900 });
    expect(seenUrl).toBe('https://api.alcoia.invalid/api/documents/doc-1/download-url');
  });

  it('with no documentId, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createAssignmentsManager({ fetchImpl, documentsUrl: DOCUMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getDownloadUrl('')).toEqual({ ok: false, error: 'no_document_id' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with no session, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const m = createAssignmentsManager({ fetchImpl, documentsUrl: DOCUMENTS_URL, getSession: sessionOf(null) });
    expect(await m.getDownloadUrl('doc-1')).toEqual({ ok: false, error: 'no_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a 404 document_not_found surfaces the server\'s own code', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'document_not_found' }) }));
    const m = createAssignmentsManager({ fetchImpl, documentsUrl: DOCUMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getDownloadUrl('gone')).toEqual({ ok: false, error: 'document_not_found' });
  });

  it('a 403 not_authorized (no active seat in that class) surfaces cleanly', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'not_authorized' }) }));
    const m = createAssignmentsManager({ fetchImpl, documentsUrl: DOCUMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getDownloadUrl('doc-1')).toEqual({ ok: false, error: 'not_authorized' });
  });

  it('a malformed success response (missing url) is rejected, not trusted', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ expiresInSeconds: 900 }) }));
    const m = createAssignmentsManager({ fetchImpl, documentsUrl: DOCUMENTS_URL, getSession: sessionOf('tok-1') });
    expect(await m.getDownloadUrl('doc-1')).toEqual({ ok: false, error: 'malformed_response' });
  });

  it('a network failure resolves to a clear error, never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    const m = createAssignmentsManager({ fetchImpl, documentsUrl: DOCUMENTS_URL, getSession: sessionOf('tok-1') });
    await expect(m.getDownloadUrl('doc-1')).resolves.toEqual({ ok: false, error: 'network_error' });
  });
});
