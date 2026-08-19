import { describe, it, expect } from 'vitest';
import {
  LADDER,
  nextLevel,
  isSystematicallyOverconfident,
  pickLevelForConcept,
  evidenceLineForLevel,
  OVERCONFIDENCE_MIN_SAMPLES,
  OVERCONFIDENCE_WRONG_RATE,
} from '../alcoia/src/content/epistemic-engine.js';

// A session where the reader answers plenty of high-confidence questions
// and is right nearly every time — well-calibrated confidence.
function wellCalibratedSession() {
  return [
    { confidence: 'high', correct: true },
    { confidence: 'high', correct: true },
    { confidence: 'high', correct: true },
    { confidence: 'low', correct: false },
  ];
}

// A session where high confidence is wrong often enough to be a pattern,
// not a one-off.
function overconfidentSession() {
  return [
    { confidence: 'high', correct: false },
    { confidence: 'high', correct: false },
    { confidence: 'high', correct: true },
  ];
}

describe('nextLevel — climbing on success', () => {
  it('correct at recognition climbs to free_recall', () => {
    expect(nextLevel({ level: 'recognition', correct: true })).toBe('free_recall');
  });

  it('correct at free_recall climbs to scenario', () => {
    expect(nextLevel({ level: 'free_recall', correct: true })).toBe('scenario');
  });

  it('correct at scenario with well-calibrated confidence stays at scenario, never adversarial', () => {
    const result = nextLevel({ level: 'scenario', correct: true }, wellCalibratedSession());
    expect(result).toBe('scenario');
    expect(result).not.toBe('adversarial');
  });

  it('correct at scenario with systematic overconfidence climbs to adversarial', () => {
    expect(nextLevel({ level: 'scenario', correct: true }, overconfidentSession())).toBe('adversarial');
  });

  it('no prior attempt at all starts at recognition', () => {
    expect(nextLevel(null)).toBe('recognition');
    expect(nextLevel(undefined)).toBe('recognition');
  });

  it('an unrecognised level in the input falls back to recognition, not a guess', () => {
    expect(nextLevel({ level: 'made_up_level', correct: true })).toBe('recognition');
  });
});

describe('nextLevel — the exact task scenario: correct at recognition, then wrong at recall', () => {
  it('selects recall again, not scenario', () => {
    const afterRecognition = nextLevel({ level: 'recognition', correct: true });
    expect(afterRecognition).toBe('free_recall');

    const afterFailedRecall = nextLevel({ level: afterRecognition, correct: false });
    expect(afterFailedRecall).toBe('free_recall');
    expect(afterFailedRecall).not.toBe('scenario');
  });
});

describe('nextLevel — failure never climbs, and never punishes past one rung', () => {
  it('wrong at recognition stays at recognition — nowhere lower to go', () => {
    expect(nextLevel({ level: 'recognition', correct: false })).toBe('recognition');
  });

  it('wrong at free_recall retries free_recall — does not fall back to recognition', () => {
    expect(nextLevel({ level: 'free_recall', correct: false })).toBe('free_recall');
  });

  it('an inconclusive (unknown) grade at free_recall also retries free_recall, not a demotion', () => {
    expect(nextLevel({ level: 'free_recall', correct: null })).toBe('free_recall');
  });

  it('failing (inconclusive) at scenario returns to recall, one rung down — never stays at scenario, never falls to recognition', () => {
    const result = nextLevel({ level: 'scenario', correct: null }, overconfidentSession());
    expect(result).toBe('free_recall');
  });
});

describe('nextLevel — a failing reader is never served adversarial', () => {
  it('scenario, not correct, even with an overconfident session history, never returns adversarial', () => {
    const result = nextLevel({ level: 'scenario', correct: false }, overconfidentSession());
    expect(result).not.toBe('adversarial');
  });

  it('scenario, inconclusive, even with an overconfident session history, never returns adversarial', () => {
    const result = nextLevel({ level: 'scenario', correct: null }, overconfidentSession());
    expect(result).not.toBe('adversarial');
  });

  it('no level other than a correct scenario can ever produce adversarial', () => {
    for (const level of LADDER) {
      if (level === 'scenario') continue;
      for (const correct of [true, false, null]) {
        expect(nextLevel({ level, correct }, overconfidentSession())).not.toBe('adversarial');
      }
    }
  });
});

describe('nextLevel — adversarial has no verdict, so it always steps back to scenario', () => {
  it('regardless of correct (adversarial answers are never graded)', () => {
    expect(nextLevel({ level: 'adversarial', correct: null })).toBe('scenario');
    expect(nextLevel({ level: 'adversarial', correct: true })).toBe('scenario');
  });
});

describe('isSystematicallyOverconfident', () => {
  it('a single wrong high-confidence answer is not "systematic"', () => {
    expect(isSystematicallyOverconfident([{ confidence: 'high', correct: false }])).toBe(false);
  });

  it('requires at least OVERCONFIDENCE_MIN_SAMPLES high-confidence graded answers before judging anything', () => {
    const almost = Array.from({ length: OVERCONFIDENCE_MIN_SAMPLES - 1 }, () => ({ confidence: 'high', correct: false }));
    expect(isSystematicallyOverconfident(almost)).toBe(false);
  });

  it('flags a wrong-rate at or above OVERCONFIDENCE_WRONG_RATE among high-confidence answers', () => {
    const wrongCount = Math.ceil(OVERCONFIDENCE_MIN_SAMPLES * OVERCONFIDENCE_WRONG_RATE);
    const sample = [
      ...Array.from({ length: wrongCount }, () => ({ confidence: 'high', correct: false })),
      ...Array.from({ length: OVERCONFIDENCE_MIN_SAMPLES - wrongCount }, () => ({ confidence: 'high', correct: true })),
    ];
    expect(isSystematicallyOverconfident(sample)).toBe(true);
  });

  it('low-confidence wrong answers never count toward overconfidence', () => {
    const allLowButWrong = Array.from({ length: 10 }, () => ({ confidence: 'low', correct: false }));
    expect(isSystematicallyOverconfident(allLowButWrong)).toBe(false);
  });

  it('unrated (null confidence) answers never count', () => {
    const unrated = Array.from({ length: 10 }, () => ({ confidence: null, correct: false }));
    expect(isSystematicallyOverconfident(unrated)).toBe(false);
  });

  it('an empty or missing session history is never overconfident', () => {
    expect(isSystematicallyOverconfident([])).toBe(false);
    expect(isSystematicallyOverconfident()).toBe(false);
  });
});

describe('pickLevelForConcept — the response-signals-history-shaped convenience wrapper', () => {
  it('a concept never seen before gets recognition', () => {
    expect(pickLevelForConcept('para-1', [])).toBe('recognition');
  });

  it('reads only the LATEST attempt for the given concept, ignoring older ones', () => {
    const history = [
      { paragraphKey: 'para-1', level: 'recognition', correct: false, subtype: 'incorrect' },
      { paragraphKey: 'para-1', level: 'recognition', correct: true, subtype: 'correct' },
    ];
    expect(pickLevelForConcept('para-1', history)).toBe('free_recall');
  });

  it('ignores attempts for a different concept entirely', () => {
    const history = [
      { paragraphKey: 'para-OTHER', level: 'scenario', correct: true, subtype: 'correct', confidence: 'high' },
    ];
    expect(pickLevelForConcept('para-1', history)).toBe('recognition');
  });

  it('a dismissal is never treated as an attempt — it does not move the concept anywhere', () => {
    const history = [
      { paragraphKey: 'para-1', level: 'recognition', correct: true, subtype: 'correct' },
      { paragraphKey: 'para-1', level: 'free_recall', correct: null, subtype: 'dismissed' },
    ];
    // The dismissal must be skipped, so the last REAL attempt (recognition,
    // correct) is what decides the next level, not the dismissal's own
    // (irrelevant) level/correct fields.
    expect(pickLevelForConcept('para-1', history)).toBe('free_recall');
  });

  it('computes systematic overconfidence from the WHOLE session, not just this concept', () => {
    const history = [
      { paragraphKey: 'para-A', level: 'scenario', correct: false, subtype: 'incorrect', confidence: 'high' },
      { paragraphKey: 'para-A', level: 'scenario', correct: false, subtype: 'incorrect', confidence: 'high' },
      { paragraphKey: 'para-B', level: 'scenario', correct: true, subtype: 'correct', confidence: 'high' },
      { paragraphKey: 'para-B', level: 'scenario', correct: true, subtype: 'correct', confidence: 'high' },
    ];
    // para-B's own two answers are both correct, but the session as a whole
    // (including para-A's wrong high-confidence answers) is overconfident.
    expect(pickLevelForConcept('para-B', history)).toBe('adversarial');
  });
});

describe('evidenceLineForLevel — item 44 tone requirement: adversarial must never read as hostile', () => {
  it('returns dedicated, calm copy for adversarial — not a "gotcha" or accusatory framing', () => {
    const line = evidenceLineForLevel('adversarial');
    expect(typeof line).toBe('string');
    expect(line.length).toBeGreaterThan(0);
    const hostileWords = ['wrong', 'gotcha', 'prove', 'fail', 'trick', 'catch you', "you're not"];
    const lower = line.toLowerCase();
    for (const word of hostileWords) expect(lower).not.toContain(word);
  });

  it('returns null for every other level — those callers keep their own evidence line', () => {
    expect(evidenceLineForLevel('recognition')).toBeNull();
    expect(evidenceLineForLevel('free_recall')).toBeNull();
    expect(evidenceLineForLevel('scenario')).toBeNull();
    expect(evidenceLineForLevel(undefined)).toBeNull();
  });
});

describe('card and quiz page produce identical selections for identical histories', () => {
  it('the same paragraphKey + history always yields the same level, called from "two surfaces"', () => {
    const history = [
      { paragraphKey: 'shared-para', level: 'recognition', correct: true, subtype: 'correct' },
      { paragraphKey: 'shared-para', level: 'free_recall', correct: true, subtype: 'correct' },
    ];
    // Simulates host.js's in-page path (handleAsk/runSessionRecall) and its
    // quiz-generation path (runQuiz) both calling this exact function with
    // the same history — there is only one engine, so there is nothing for
    // the two call sites to disagree about.
    const cardSurfaceResult = pickLevelForConcept('shared-para', history);
    const quizSurfaceResult = pickLevelForConcept('shared-para', history);
    expect(cardSurfaceResult).toBe(quizSurfaceResult);
    expect(cardSurfaceResult).toBe('scenario');
  });

  it('holds across every rung of the ladder, not just one example', () => {
    const histories = [
      [],
      [{ paragraphKey: 'p', level: 'recognition', correct: false, subtype: 'incorrect' }],
      [{ paragraphKey: 'p', level: 'recognition', correct: true, subtype: 'correct' }],
      [{ paragraphKey: 'p', level: 'free_recall', correct: true, subtype: 'correct' }],
      [{ paragraphKey: 'p', level: 'scenario', correct: null, subtype: 'unknown' }],
      [{ paragraphKey: 'p', level: 'adversarial', correct: null, subtype: 'ungraded' }],
    ];
    for (const history of histories) {
      expect(pickLevelForConcept('p', history)).toBe(pickLevelForConcept('p', history));
    }
  });
});
