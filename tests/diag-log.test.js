import { describe, it, expect, vi } from 'vitest';
import { createDiagLog } from '../alcoia/src/shared/diag-log.js';

function fakeStorage() {
  let data = {};
  return {
    get: (keys, cb) => {
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
      cb(out);
    },
    set: (obj, cb) => { data = { ...data, ...obj }; cb && cb(); },
    _dump: () => data,
  };
}

describe('diag-log', () => {
  it('records an entry with a timestamp, context and message', async () => {
    const storage = fakeStorage();
    const d = createDiagLog({ storage, now: () => 12345 });
    await d.log('summarize', 'status_500');
    const entries = await d.list();
    expect(entries).toEqual([{ at: 12345, context: 'summarize', message: 'status_500' }]);
  });

  it('newest entry first', async () => {
    const storage = fakeStorage();
    const d = createDiagLog({ storage });
    await d.log('a', '1');
    await d.log('b', '2');
    const entries = await d.list();
    expect(entries.map((e) => e.context)).toEqual(['b', 'a']);
  });

  it('caps at maxEntries, dropping the oldest', async () => {
    const storage = fakeStorage();
    const d = createDiagLog({ storage, maxEntries: 3 });
    for (let i = 0; i < 5; i++) await d.log('ctx', `msg${i}`);
    const entries = await d.list();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.message)).toEqual(['msg4', 'msg3', 'msg2']);
  });

  /* This page is explicitly required to be "safe to screenshot" — no URLs,
   * titles or passage text may ever surface through it, even if a caller
   * passes an exception whose .message happens to embed one. */
  it('strips any http(s) URL out of the message before storing it', async () => {
    const storage = fakeStorage();
    const d = createDiagLog({ storage });
    await d.log('summarize', 'failed fetching https://api.alcoia.invalid/api/summarize?x=1 badly');
    const [entry] = await d.list();
    expect(entry.message).not.toMatch(/https?:\/\//);
    expect(entry.message).toBe('failed fetching [url removed] badly');
  });

  it('truncates an overlong message rather than storing it whole', async () => {
    const storage = fakeStorage();
    const d = createDiagLog({ storage });
    await d.log('ctx', 'x'.repeat(500));
    const [entry] = await d.list();
    expect(entry.message.length).toBe(200);
  });

  it('clear() empties the log', async () => {
    const storage = fakeStorage();
    const d = createDiagLog({ storage });
    await d.log('a', '1');
    await d.clear();
    expect(await d.list()).toEqual([]);
  });

  it('list() on an empty log returns an empty array, not null/undefined', async () => {
    const storage = fakeStorage();
    const d = createDiagLog({ storage });
    expect(await d.list()).toEqual([]);
  });

  it('never throws when storage is unavailable', async () => {
    const d = createDiagLog({ storage: null });
    await expect(d.log('a', 'b')).resolves.toBeUndefined();
    await expect(d.list()).resolves.toEqual([]);
    await expect(d.clear()).resolves.toBeUndefined();
  });

  it('a logging failure inside storage.get does not throw past log()', async () => {
    const storage = { get: () => { throw new Error('boom'); }, set: vi.fn() };
    const d = createDiagLog({ storage });
    await expect(d.log('a', 'b')).resolves.toBeUndefined();
  });
});
