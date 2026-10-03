import { describe, it, expect } from 'vitest';
import { readerAssignmentId } from '../alcoia/src/shared/reader-context.js';

const ORIGIN = 'https://reader.alcoia.app';
const ID = '11111111-1111-4111-8111-111111111111';
const at = (origin, pathname) => ({ origin, pathname });

describe('readerAssignmentId', () => {
  it('returns the assignment id on /a/<uuid> at the reader origin', () => {
    expect(readerAssignmentId(at(ORIGIN, `/a/${ID}`), ORIGIN)).toBe(ID);
    expect(readerAssignmentId(at(ORIGIN, `/a/${ID}/`), ORIGIN)).toBe(ID);
  });
  it('lower-cases the id', () => {
    expect(readerAssignmentId(at(ORIGIN, `/a/${ID.toUpperCase()}`), ORIGIN)).toBe(ID);
  });
  it('is null for other paths on the reader origin', () => {
    for (const p of ['/', '/assignments', '/sign-in', '/a/', '/a/not-a-uuid', `/a/${ID}/extra`, `/b/${ID}`]) {
      expect(readerAssignmentId(at(ORIGIN, p), ORIGIN)).toBeNull();
    }
  });
  it('is null on any other origin, even with a matching path', () => {
    expect(readerAssignmentId(at('https://evil.example', `/a/${ID}`), ORIGIN)).toBeNull();
    expect(readerAssignmentId(at('https://reader.alcoia.app.evil.example', `/a/${ID}`), ORIGIN)).toBeNull();
  });
  it('is null when there is no location or origin configured', () => {
    expect(readerAssignmentId(null, ORIGIN)).toBeNull();
    expect(readerAssignmentId(at(ORIGIN, `/a/${ID}`), undefined)).toBeNull();
  });
});
