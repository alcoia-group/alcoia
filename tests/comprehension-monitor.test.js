// @vitest-environment jsdom
/* comprehension-monitor.js had no test file: nothing covered the running
 * median WPM baseline, its chrome.storage persistence, the speed-mismatch
 * thresholds, or — the one that matters most — the reader-to-self comparison
 * that is supposed to stop the system quizzing a slow reader for reading
 * slowly. This file closes that gap directly against the real module, not a
 * fake standing in for it.
 *
 * comprehension-monitor.js reads Date.now() directly rather than accepting an
 * injected clock, so time is controlled with vi's fake timers throughout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createComprehensionMonitor } from '../alcoia/src/content/comprehension-monitor.js';
import { analyzeDifficulty } from '../alcoia/src/content/telemetry/text-difficulty.js';

// Short sentences, simple words: scores as 'easy' (>=80), which is one of the
// two grades the WPM baseline is allowed to learn from.
const EASY = (n) => {
  const s = 'The cat sat on the mat and looked at the dog. ';
  return s.repeat(Math.ceil(n / 10)).trim();
};

// Longer sentences, a subordinator, real punctuation: scores as 'difficult'
// (40-59), not 'very_difficult' — the too_slow path explicitly excludes
// very_difficult text, so a 'difficult' fixture is what exercises it.
const DIFFICULT = (n) => {
  const s = 'The committee reviewed the proposal because several members believed it needed further amendment. '
    + 'Although the initial draft was carefully prepared, considerable disagreement remained among the delegates. ';
  return s.repeat(Math.ceil(n / 24)).trim();
};

function el(text) { return { innerText: text, textContent: text }; }

function fakeChromeStorage(seed = {}) {
  const store = { ...seed };
  return {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
          cb(result);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
      },
    },
    _store: store,
  };
}

function scrollTo(y) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  document.documentElement.lang = 'en';
  scrollTo(0);
  globalThis.chrome = fakeChromeStorage();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.chrome;
});

describe('paragraph entry', () => {
  it('ignores a paragraph under the word-count floor', () => {
    const m = createComprehensionMonitor();
    m.enterParagraph(el('too short to matter'));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph()).toBeNull();
  });

  it('says nothing when nothing was entered', () => {
    const m = createComprehensionMonitor();
    expect(m.leaveParagraph()).toBeNull();
  });

  it('reports the current expectation while a paragraph is active, and null otherwise', () => {
    const m = createComprehensionMonitor();
    expect(m.getCurrentExpectation()).toBeNull();
    m.enterParagraph(el(EASY(120)));
    const exp = m.getCurrentExpectation();
    expect(exp.expectedMs).toBeGreaterThan(0);
    expect(exp.enteredAt).toBe(Date.now());
  });
});

describe('personal WPM baseline', () => {
  it('is null until 5 samples exist, then becomes the running median', () => {
    const m = createComprehensionMonitor();
    expect(m.getBaselineWpm()).toBeNull();

    const text = EASY(120);
    const wordCount = analyzeDifficulty(text, { lang: 'en' }).wordCount;
    const elapsedMs = 25000;
    const expectedWpm = Math.round((wordCount / elapsedMs) * 60000);

    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(elapsedMs);
      m.leaveParagraph();
    }
    expect(m.getBaselineWpm()).toBe(expectedWpm);
  });

  it('persists the legacy baseline key once established, and a fresh monitor hydrates from it', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(20000);
      m.leaveParagraph();
    }
    const persisted = globalThis.chrome._store.sra_baseline_wpm;
    expect(persisted).toBeGreaterThan(0);
    expect(persisted).toBe(m.getBaselineWpm());

    globalThis.chrome = fakeChromeStorage({ sra_baseline_wpm: persisted, sra_baseline_wpm_by_lang: {} });
    const fresh = createComprehensionMonitor();
    expect(fresh.getBaselineWpm()).toBe(persisted);
  });

  it('persists a per-language baseline map after the debounce window', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(20000);
      m.leaveParagraph();
    }
    vi.advanceTimersByTime(2000);   // flush the debounced write
    expect(globalThis.chrome._store.sra_baseline_wpm_by_lang).toEqual({ en: m.getBaselineWpm() });
  });
});

describe('speed-mismatch thresholds', () => {
  it('flags dense text read implausibly fast', () => {
    const m = createComprehensionMonitor();
    m.enterParagraph(el(DIFFICULT(80)));
    vi.advanceTimersByTime(5000);   // well under the ~39s a 160wpm generic reader would take
    const sig = m.leaveParagraph();
    expect(sig.type).toBe('speed_mismatch');
    expect(sig.subtype).toBe('too_fast');
  });

  it('flags a paragraph read far slower than the reader’s own established baseline', () => {
    const m = createComprehensionMonitor();
    const text = EASY(120);
    const steady = 25000;
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(steady);
      m.leaveParagraph();
    }
    const baseline = m.getBaselineWpm();
    expect(baseline).toBeGreaterThan(0);

    m.enterParagraph(el(text));
    vi.advanceTimersByTime(steady * 3);   // a third of their own established pace
    const sig = m.leaveParagraph();
    expect(sig.type).toBe('speed_mismatch');
    expect(sig.subtype).toBe('too_slow');
    expect(sig.baselineWpm).toBe(baseline);
  });

  it('suppresses further offers during the cooldown window, and resumes after it', () => {
    const m = createComprehensionMonitor();
    const text = DIFFICULT(80);

    m.enterParagraph(el(text));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph().subtype).toBe('too_fast');
    m.markOfferShown();

    m.enterParagraph(el(text));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph()).toBeNull();   // same qualifying read, still cooling down

    vi.advanceTimersByTime(30000);           // COOLDOWN_MS
    m.enterParagraph(el(text));
    vi.advanceTimersByTime(5000);
    expect(m.leaveParagraph().subtype).toBe('too_fast');
  });
});

describe('the fairness safeguard: unusual for this reader, not unusual by a fixed rule', () => {
  it('stops flagging a reader’s own steady-but-slow pace once it has learned that pace, while still catching a real outlier', () => {
    const m = createComprehensionMonitor();

    // hasSamples() — the gate too_slow requires — only counts real samples
    // accumulated this session; seedWpmFromCalibration() alone isn't enough
    // (it seeds a value, not a sample count). Establish it the same way a
    // real session would: five ordinary easy paragraphs read at a steady
    // pace. Difficult-text reads never contribute to the baseline (only
    // standard/easy do), so once this is set it stays fixed as the yardstick
    // for every "slow" read below.
    const warmupText = EASY(120);
    const warmupWordCount = analyzeDifficulty(warmupText, { lang: 'en' }).wordCount;
    const warmupElapsed = Math.round((warmupWordCount / 250) * 60000);   // targets ~250 wpm
    for (let i = 0; i < 5; i++) {
      m.enterParagraph(el(warmupText));
      vi.advanceTimersByTime(warmupElapsed);
      m.leaveParagraph();
    }
    const baseline = m.getBaselineWpm();
    expect(baseline).toBeGreaterThan(0);

    const text = DIFFICULT(90);   // grade 'difficult': eligible for too_slow, and excluded from the baseline itself
    const wordCount = analyzeDifficulty(text, { lang: 'en' }).wordCount;
    const expectedMs = wordCount / (baseline * 0.72) * 60000; // expectedReadingMs's own difficulty multiplier for 'difficult'

    const read = (ratio) => {
      m.enterParagraph(el(text));
      vi.advanceTimersByTime(Math.round(ratio * expectedMs));
      return m.leaveParagraph();
    };

    // First-ever read: this reader is consistently slower than the model,
    // but there is no history yet, so the fixed 50%-of-baseline rule alone
    // judges it — and flags it, which is exactly the "quizzed for reading
    // slowly" failure mode the fairness comparison exists to prevent.
    const first = read(1.8);
    expect(first.type).toBe('speed_mismatch');
    expect(first.subtype).toBe('too_slow');
    m.markOfferShown();

    // Give it 30s of headroom past the cooldown before continuing, then
    // build eight more readings at essentially the same personal pace (with
    // the small natural variation any real session would have) so the
    // reader's own residual distribution has enough history to trust.
    vi.advanceTimersByTime(30000);
    const ramp = [1.75, 1.8, 1.85, 1.9, 1.75, 1.85, 1.8];
    for (const ratio of ramp) {
      read(ratio);
      vi.advanceTimersByTime(30000);   // clear the cooldown between samples
    }

    // Same pace as always for this reader. It is no longer unusual *for
    // them*, so it must not fire — even though it is still well under 50%
    // of the fixed baseline, the rule that flagged the very first read.
    const typical = read(1.8);
    expect(typical).toBeNull();
    vi.advanceTimersByTime(30000);

    // A genuine outlier — far slower than even this reader's own slow norm —
    // must still be caught. The safeguard raises the bar to "unusual for
    // this reader"; it does not switch struggle detection off.
    const outlier = read(6);
    expect(outlier.type).toBe('speed_mismatch');
    expect(outlier.subtype).toBe('too_slow');
  });
});

describe('scroll backtrack', () => {
  it('flags scrolling down and then sharply back up', () => {
    const m = createComprehensionMonitor();
    for (const y of [100, 250, 400, 500]) {
      scrollTo(y);
      expect(m.onScroll()).toBeNull();
      vi.advanceTimersByTime(200);
    }
    scrollTo(50);
    const sig = m.onScroll();
    expect(sig.type).toBe('backtrack');
    expect(sig.backtrackPx).toBe(450);
  });

  it('ignores small movements back up', () => {
    const m = createComprehensionMonitor();
    for (const y of [100, 150, 200, 250]) {
      scrollTo(y);
      expect(m.onScroll()).toBeNull();
      vi.advanceTimersByTime(200);
    }
    scrollTo(220);   // a 30px correction, not a regression
    expect(m.onScroll()).toBeNull();
  });
});
