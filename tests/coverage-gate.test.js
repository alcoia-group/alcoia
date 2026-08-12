import { describe, it, expect } from 'vitest';
import { createCoverageGate, documentKey, DEFAULT_THRESHOLDS } from '../alcoia/src/content/coverage-gate.js';

function fakeStorage() {
  let data = {};
  return {
    get: (keys, cb) => {
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
      cb(out);
    },
    set: (obj, cb) => { data = { ...data, ...obj }; cb && cb(); },
  };
}

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const KEY = 'example.com/article';

// One paragraph of realistic size, read at a normal pace.
const READ = (i, dwellMs = 5000) => ({
  text: `paragraph number ${i} with some genuinely distinct words in it`,
  words: 120, dwellMs, totalParagraphs: 10,
});

describe('documentKey', () => {
  it('is hostname + pathname, nothing else', () => {
    expect(documentKey({ hostname: 'example.com', pathname: '/a/article', search: '?x=1', hash: '#y' }))
      .toBe('example.com/a/article');
  });

  it('is unaffected by a query string', () => {
    const a = documentKey({ hostname: 'example.com', pathname: '/p', search: '' });
    const b = documentKey({ hostname: 'example.com', pathname: '/p', search: '?utm_source=newsletter&utm_medium=email' });
    expect(a).toBe(b);
  });

  it('is unaffected by a hash', () => {
    const a = documentKey({ hostname: 'example.com', pathname: '/p', hash: '' });
    const b = documentKey({ hostname: 'example.com', pathname: '/p', hash: '#section-3' });
    expect(a).toBe(b);
  });

  it('changes when the pathname actually changes (a real SPA navigation)', () => {
    const a = documentKey({ hostname: 'example.com', pathname: '/article-one' });
    const b = documentKey({ hostname: 'example.com', pathname: '/article-two' });
    expect(a).not.toBe(b);
  });

  it('returns null with no location to read', () => {
    expect(documentKey(null)).toBeNull();
    expect(documentKey({})).toBeNull();
  });
});

describe('evaluate() before anything is tracked', () => {
  it('is not ready, with the exact required reason', () => {
    const gate = createCoverageGate({ storage: fakeStorage(), now: fixedClock().now });
    return gate.evaluate(KEY).then((r) => {
      expect(r.ready).toBe(false);
      expect(r.reason).toBe('not enough reading tracked on this page yet');
      expect(r.coveragePct).toBeNull();
    });
  });

  it('is not ready for a key that was never given', () => {
    const gate = createCoverageGate({ storage: fakeStorage(), now: fixedClock().now });
    return gate.evaluate(null).then((r) => expect(r.ready).toBe(false));
  });
});

describe('accumulating coverage', () => {
  it('reaches ready once enough distinct paragraphs and enough dwell time are recorded', async () => {
    const clock = fixedClock();
    const gate = createCoverageGate({ storage: fakeStorage(), now: clock.now });
    // 10 total paragraphs; 60% threshold needs 6; dwell threshold is 60s.
    for (let i = 0; i < 6; i++) await gate.recordProgress(KEY, READ(i, 12000));
    const r = await gate.evaluate(KEY);
    expect(r.ready).toBe(true);
    expect(r.coveragePct).toBe(60);
    expect(r.dwellMs).toBe(72000);
  });

  it('is not ready on coverage alone without enough dwell time', async () => {
    const gate = createCoverageGate({ storage: fakeStorage(), now: fixedClock().now });
    // 6/10 paragraphs (60%) but only 1s each — a fast scroll-through, not reading.
    for (let i = 0; i < 6; i++) await gate.recordProgress(KEY, READ(i, 1000));
    const r = await gate.evaluate(KEY);
    expect(r.ready).toBe(false);
    expect(r.coveragePct).toBe(60);
    expect(r.reason).toBe('not enough reading tracked on this page yet');
  });

  it('is not ready on dwell time alone without enough distinct coverage', async () => {
    const gate = createCoverageGate({ storage: fakeStorage(), now: fixedClock().now });
    // Same 2 paragraphs, reread for a long time — plenty of dwell, low coverage.
    for (let i = 0; i < 20; i++) await gate.recordProgress(KEY, READ(i % 2, 10000));
    const r = await gate.evaluate(KEY);
    expect(r.coveragePct).toBe(20);
    expect(r.dwellMs).toBeGreaterThan(DEFAULT_THRESHOLDS.minDwellMs);
    expect(r.ready).toBe(false);
  });

  it('never regresses coverage by rereading the same paragraph twice', async () => {
    const gate = createCoverageGate({ storage: fakeStorage(), now: fixedClock().now });
    await gate.recordProgress(KEY, READ(0, 5000));
    await gate.recordProgress(KEY, READ(0, 5000)); // same paragraph again
    const r = await gate.evaluate(KEY);
    expect(r.coveragePct).toBe(10); // 1/10, not 2/10
    expect(r.dwellMs).toBe(10000); // dwell still accrues on a reread
  });

  it('never counts a media landmark toward coverage', async () => {
    const gate = createCoverageGate({ storage: fakeStorage(), now: fixedClock().now });
    await gate.recordProgress(KEY, { text: 'a figure', words: 0, dwellMs: 5000, media: true, totalParagraphs: 10 });
    const r = await gate.evaluate(KEY);
    expect(r.ready).toBe(false);
    expect(r.coveragePct).toBeNull(); // nothing tracked at all yet
  });

  it('accumulates across separate calls as if across separate visits — reading half today and half tomorrow reaches the threshold tomorrow', async () => {
    const storage = fakeStorage();
    const clock = fixedClock();

    // "Today": one visit, one instance, reads 3 of 10 paragraphs.
    const today = createCoverageGate({ storage, now: clock.now });
    for (let i = 0; i < 3; i++) await today.recordProgress(KEY, READ(i, 12000));
    expect((await today.evaluate(KEY)).ready).toBe(false);

    // "Tomorrow": a fresh gate instance (as a new page load would create),
    // same persisted storage, reads the remaining paragraphs.
    clock.advance(86400000);
    const tomorrow = createCoverageGate({ storage, now: clock.now });
    for (let i = 3; i < 6; i++) await tomorrow.recordProgress(KEY, READ(i, 12000));
    const r = await tomorrow.evaluate(KEY);
    expect(r.ready).toBe(true);
    expect(r.coveragePct).toBe(60);
  });

  it('keeps separate documents separate', async () => {
    const storage = fakeStorage();
    const gate = createCoverageGate({ storage, now: fixedClock().now });
    for (let i = 0; i < 6; i++) await gate.recordProgress('a.com/one', { ...READ(i, 12000) });
    const other = await gate.evaluate('a.com/two');
    expect(other.ready).toBe(false);
    expect(other.coveragePct).toBeNull();
  });

  it('a growing totalParagraphs (lazy-loaded content) only ever grows the known denominator', async () => {
    const gate = createCoverageGate({ storage: fakeStorage(), now: fixedClock().now });
    await gate.recordProgress(KEY, { text: 'p0', words: 100, dwellMs: 12000, totalParagraphs: 10 });
    await gate.recordProgress(KEY, { text: 'p1', words: 100, dwellMs: 12000, totalParagraphs: 5 }); // stale, smaller
    const r = await gate.evaluate(KEY);
    expect(r.coveragePct).toBe(20); // 2/10, not 2/5 — the smaller report is ignored
  });
});

describe('clear()', () => {
  it('deletes one document without touching others', async () => {
    const storage = fakeStorage();
    const gate = createCoverageGate({ storage, now: fixedClock().now });
    await gate.recordProgress('a.com/one', READ(0, 12000));
    await gate.recordProgress('a.com/two', READ(0, 12000));
    await gate.clear('a.com/one');
    expect((await gate.evaluate('a.com/one')).coveragePct).toBeNull();
    expect((await gate.evaluate('a.com/two')).coveragePct).not.toBeNull();
  });

  it('clears everything when called with no key', async () => {
    const storage = fakeStorage();
    const gate = createCoverageGate({ storage, now: fixedClock().now });
    await gate.recordProgress('a.com/one', READ(0, 12000));
    await gate.clear();
    expect((await gate.evaluate('a.com/one')).coveragePct).toBeNull();
  });
});

describe('storage cap', () => {
  it('evicts the least-recently-updated document once the cap is exceeded', async () => {
    const storage = fakeStorage();
    const clock = fixedClock();
    const gate = createCoverageGate({ storage, now: clock.now, thresholds: {} });
    // Fill past the 150-document cap; the very first key should be evicted.
    for (let i = 0; i < 151; i++) {
      clock.advance(1000);
      await gate.recordProgress(`site.com/doc-${i}`, READ(0, 1000));
    }
    expect((await gate.evaluate('site.com/doc-0')).coveragePct).toBeNull();
    expect((await gate.evaluate('site.com/doc-150')).coveragePct).not.toBeNull();
  });
});

describe('configurable thresholds', () => {
  it('honours a stricter or looser configuration', async () => {
    const gate = createCoverageGate({
      storage: fakeStorage(), now: fixedClock().now,
      thresholds: { minCoveragePct: 90, minDwellMs: 1000 },
    });
    for (let i = 0; i < 6; i++) await gate.recordProgress(KEY, READ(i, 2000));
    expect((await gate.evaluate(KEY)).ready).toBe(false); // 60% < 90%
  });
});
