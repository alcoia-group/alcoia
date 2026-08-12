import { describe, it, expect, vi } from 'vitest';
import { createQuizOfferChecker, isNearBottom } from '../alcoia/src/content/quiz-offer.js';

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

function fakeWin(scrollY, viewportHeight) { return { scrollY, innerHeight: viewportHeight }; }
function fakeDoc(scrollHeight) { return { documentElement: { scrollHeight } }; }

function readyGate(result = { ready: true, reason: 'read 80% of the page', coveragePct: 80, dwellMs: 90000 }) {
  return { evaluate: vi.fn(async () => result) };
}

describe('isNearBottom', () => {
  it('is false well above the bottom', () => {
    expect(isNearBottom(0, 800, 5000)).toBe(false);
  });
  it('is true once within the default margin of the bottom', () => {
    expect(isNearBottom(4300, 800, 5000)).toBe(true); // 4300+800=5100 >= 5000-200
  });
  it('is false with no known document height', () => {
    expect(isNearBottom(9999, 800, 0)).toBe(false);
  });
  it('honours a custom margin', () => {
    expect(isNearBottom(4000, 800, 5000, 0)).toBe(false); // 4800 < 5000
    expect(isNearBottom(4200, 800, 5000, 0)).toBe(true);  // 5000 >= 5000
  });
});

describe('createQuizOfferChecker', () => {
  it('does nothing when not near the bottom', async () => {
    const coverageGate = readyGate();
    const checker = createQuizOfferChecker({
      storage: fakeStorage(), coverageGate, documentKey: () => 'a.com/p',
      window: fakeWin(0, 800), document: fakeDoc(5000),
    });
    await checker.check();
    expect(coverageGate.evaluate).not.toHaveBeenCalled();
  });

  it('fires onEligible once coverage is ready and the reader is near the bottom', async () => {
    const coverageGate = readyGate();
    const onEligible = vi.fn();
    const checker = createQuizOfferChecker({
      storage: fakeStorage(), coverageGate, documentKey: () => 'a.com/p', onEligible,
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    await checker.check();
    expect(onEligible).toHaveBeenCalledTimes(1);
    expect(onEligible.mock.calls[0][0]).toMatchObject({ ready: true, key: 'a.com/p' });
  });

  it('does not fire when coverage is not ready, even at the bottom', async () => {
    const coverageGate = readyGate({ ready: false, reason: 'not enough reading tracked on this page yet', coveragePct: 20, dwellMs: 1000 });
    const onEligible = vi.fn();
    const checker = createQuizOfferChecker({
      storage: fakeStorage(), coverageGate, documentKey: () => 'a.com/p', onEligible,
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    await checker.check();
    expect(onEligible).not.toHaveBeenCalled();
  });

  it('only ever offers once per document', async () => {
    const coverageGate = readyGate();
    const onEligible = vi.fn();
    const storage = fakeStorage();
    const checker = createQuizOfferChecker({
      storage, coverageGate, documentKey: () => 'a.com/p', onEligible,
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    await checker.check();
    await checker.check();
    await checker.check();
    expect(onEligible).toHaveBeenCalledTimes(1);
  });

  it('a second, different document still gets its own offer', async () => {
    const coverageGate = readyGate();
    const onEligible = vi.fn();
    const storage = fakeStorage();
    let key = 'a.com/one';
    const checker = createQuizOfferChecker({
      storage, coverageGate, documentKey: () => key, onEligible,
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    await checker.check();
    key = 'a.com/two';
    await checker.check();
    expect(onEligible).toHaveBeenCalledTimes(2);
  });

  it('hasBeenOffered reflects a prior offer', async () => {
    const storage = fakeStorage();
    const checker = createQuizOfferChecker({
      storage, coverageGate: readyGate(), documentKey: () => 'a.com/p',
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    expect(await checker.hasBeenOffered('a.com/p')).toBe(false);
    await checker.check();
    expect(await checker.hasBeenOffered('a.com/p')).toBe(true);
  });

  it('never calls onEligible when documentKey() returns null', async () => {
    const coverageGate = readyGate();
    const onEligible = vi.fn();
    const checker = createQuizOfferChecker({
      storage: fakeStorage(), coverageGate, documentKey: () => null, onEligible,
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    await checker.check();
    expect(coverageGate.evaluate).not.toHaveBeenCalled();
    expect(onEligible).not.toHaveBeenCalled();
  });

  it('does not spend the interruption budget or touch response-signals — pure function of coverage and scroll', async () => {
    // Structural: this module takes no intervention-policy or
    // response-signals dependency at all, so there is nothing it could call.
    const checker = createQuizOfferChecker({
      storage: fakeStorage(), coverageGate: readyGate(), documentKey: () => 'a.com/p',
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    expect(Object.keys(checker)).toEqual(['check', 'hasBeenOffered']);
  });

  it('evicts the least-recently-offered document once the cap is exceeded', async () => {
    const storage = fakeStorage();
    const clock = fixedClock();
    const checker = createQuizOfferChecker({
      storage, coverageGate: readyGate(), now: clock.now,
      documentKey: () => checker._key,
      window: fakeWin(4300, 800), document: fakeDoc(5000),
    });
    for (let i = 0; i < 151; i++) {
      clock.advance(1000);
      checker._key = `site.com/doc-${i}`;
      await checker.check();
    }
    expect(await checker.hasBeenOffered('site.com/doc-0')).toBe(false);
    expect(await checker.hasBeenOffered('site.com/doc-150')).toBe(true);
  });
});
