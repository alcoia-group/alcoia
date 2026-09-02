import { describe, it, expect } from 'vitest';
import { createResponseSignals } from '../alcoia/src/content/signals/response-signals.js';
import { createReadingStateEngine, STATES } from '../alcoia/src/content/state-engine.js';
import { createInterventionPolicy } from '../alcoia/src/content/intervention-policy.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const QUESTION = {
  q: 'What is the relationship described as?',
  options: ['Real but weak', 'Strong', 'Absent', 'Exact'],
  answerIndex: 0,
  explanation: 'The passage says real but weak.',
  span: 'The relationship is real but weak.',
};

describe('response-signals', () => {
  it('scores a correct answer and records how long it took', () => {
    const clock = fixedClock();
    const r = createResponseSignals({ now: clock.now });
    r.present(QUESTION, { paragraphKey: 'p1' });
    clock.advance(4000);
    const rec = r.answer(0, QUESTION);

    expect(rec.correct).toBe(true);
    expect(rec.subtype).toBe('correct');
    expect(rec.latencyMs).toBe(4000);
    expect(rec.slow).toBe(false);
    expect(rec.span).toBe(QUESTION.span);
  });

  it('scores a wrong answer', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION);
    const rec = r.answer(2, QUESTION);
    expect(rec.correct).toBe(false);
    expect(rec.subtype).toBe('incorrect');
  });

  /* Item 13j-1: which option was actually chosen — correct or incorrect —
   * so the server can compute distractor clustering
   * (alcoiaServer/src/outcomes/classify.js). */
  describe('chosenIndex (item 13j-1)', () => {
    it('records the real chosen index on a correct answer', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present(QUESTION);
      expect(r.answer(0, QUESTION).chosenIndex).toBe(0);
    });

    it('records the real chosen index on a wrong answer too — the whole point', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present(QUESTION);
      expect(r.answer(2, QUESTION).chosenIndex).toBe(2);
    });

    it('answerGraded() (free_recall/scenario) never sets chosenIndex — no discrete option exists', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present({ ...QUESTION, level: 'free_recall' });
      const rec = r.answerGraded('my answer', 'correct', 'high');
      expect(rec.chosenIndex).toBeUndefined();
    });

    it('respond() (adversarial) never sets chosenIndex either', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present({ ...QUESTION, level: 'adversarial' });
      const rec = r.respond('my argument', 'low');
      expect(rec.chosenIndex).toBeUndefined();
    });
  });

  /* Confidence is captured at commit time, alongside the answer — see
   * CLAUDE.md's confidence-calibration shape. Skippable: an omitted rating
   * must resolve to null, never to a guessed 'low' or 'high'. */
  describe('commit-time confidence', () => {
    it.each(['low', 'high'])('records a valid %s rating', (level) => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present(QUESTION);
      expect(r.answer(0, QUESTION, level).confidence).toBe(level);
    });

    it('defaults to null when the reader skips rating it', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present(QUESTION);
      expect(r.answer(0, QUESTION).confidence).toBeNull();
    });

    it('normalizes anything that is not exactly low/high to null, never a guess', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      for (const bogus of [undefined, null, '', 'medium', 'HIGH', 3]) {
        r.present(QUESTION);
        expect(r.answer(0, QUESTION, bogus).confidence).toBeNull();
      }
    });

    it('is independent of correctness — recorded the same way whether right or wrong', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present(QUESTION);
      expect(r.answer(0, QUESTION, 'high').confidence).toBe('high'); // correct
      r.present(QUESTION);
      expect(r.answer(2, QUESTION, 'high').confidence).toBe('high'); // wrong
    });
  });

  /* answerGraded() (free_recall/scenario) — confirmed correct already, but
   * given an explicit test of its own per the same rigor respond()'s bug
   * fix below gets, rather than trusted from reading the code alone. */
  describe('commit-time confidence — answerGraded (free_recall/scenario)', () => {
    it.each(['low', 'high'])('records a valid %s rating', (level) => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present({ ...QUESTION, level: 'free_recall' });
      expect(r.answerGraded('an answer', 'correct', level).confidence).toBe(level);
    });

    it('defaults to null when the reader skips rating it', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present({ ...QUESTION, level: 'scenario' });
      expect(r.answerGraded('an answer', 'correct').confidence).toBeNull();
    });

    it('normalizes anything not exactly low/high to null', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      for (const bogus of [undefined, null, '', 'medium', 'HIGH', 3]) {
        r.present({ ...QUESTION, level: 'scenario' });
        expect(r.answerGraded('an answer', 'correct', bogus).confidence).toBeNull();
      }
    });
  });

  /* respond() (adversarial) — BUG FIX. Found during the assignment-outcomes
   * work: this function used to hardcode `confidence: null` regardless of
   * what the reader actually picked in the UI (question-card.js's own
   * showConfidenceStep() runs identically for adversarial), silently
   * discarding it before it ever reached state-engine.js, the receipt, or
   * host.js's outcome-reporting chokepoint. Fixed to accept and normalize
   * it the same way answer()/answerGraded() already did — confirmed
   * `correct`/`gradingMethod` are untouched by the fix, per this task's own
   * explicit "confidence only" scope. */
  describe('commit-time confidence — respond (adversarial) — bug fix', () => {
    it.each(['low', 'high'])('records a valid %s rating — was previously always discarded to null', (level) => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present({ ...QUESTION, level: 'adversarial' });
      const rec = r.respond('an argument', level);
      expect(rec.confidence).toBe(level);
      // The fix is confidence-only — grading behaviour is unchanged.
      expect(rec.correct).toBeNull();
      expect(rec.gradingMethod).toBe('none');
      expect(rec.subtype).toBe('ungraded');
    });

    it('defaults to null when the reader skips rating it — unchanged, still correct', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      r.present({ ...QUESTION, level: 'adversarial' });
      expect(r.respond('an argument').confidence).toBeNull();
    });

    it('normalizes anything not exactly low/high to null, never a guess', () => {
      const r = createResponseSignals({ now: fixedClock().now });
      for (const bogus of [undefined, null, '', 'medium', 'HIGH', 3]) {
        r.present({ ...QUESTION, level: 'adversarial' });
        expect(r.respond('an argument', bogus).confidence).toBeNull();
      }
    });
  });

  it('flags an answer that took a long time without treating it as wrong', () => {
    const clock = fixedClock();
    const r = createResponseSignals({ now: clock.now, slowAnswerMs: 10000 });
    r.present(QUESTION);
    clock.advance(30000);
    const rec = r.answer(0, QUESTION);
    expect(rec.slow).toBe(true);
    expect(rec.correct).toBe(true);
  });

  it('counts revisions and scroll-backs without scoring them', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION);
    r.revise(); r.revise();
    r.markScrollBack();
    const rec = r.answer(0, QUESTION);
    expect(rec.revisions).toBe(2);
    expect(rec.scrolledBack).toBe(true);
    expect(rec.correct).toBe(true);
  });

  /* Declining to be tested is the reader's right and says nothing about
   * whether they understood the passage. */
  it('does not score a dismissal as a wrong answer', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION);
    const rec = r.dismiss();
    expect(rec.subtype).toBe('dismissed');
    expect(rec.correct).toBeNull();
  });

  it('ignores an answer when nothing was asked', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    expect(r.answer(0, QUESTION)).toBeNull();
    expect(r.dismiss()).toBeNull();
  });

  it('tags an exploration-sample record so it stays identifiable downstream', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphKey: 'p1', wasExplorationSample: true });
    const rec = r.answer(0, QUESTION);
    expect(rec.wasExplorationSample).toBe(true);
  });

  it('defaults wasExplorationSample to false for an ordinary ask', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION);
    const rec = r.answer(0, QUESTION);
    expect(rec.wasExplorationSample).toBe(false);
  });

  it('carries the exploration tag through a dismissal too', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { wasExplorationSample: true });
    const rec = r.dismiss();
    expect(rec.wasExplorationSample).toBe(true);
  });

  it('reports session stats for the receipt', () => {
    const clock = fixedClock();
    const r = createResponseSignals({ now: clock.now });

    r.present(QUESTION); clock.advance(3000); r.answer(0, QUESTION);   // correct
    r.present(QUESTION); clock.advance(9000); r.answer(1, QUESTION);   // wrong
    r.present(QUESTION); clock.advance(1000); r.dismiss();

    const s = r.stats();
    expect(s.asked).toBe(3);
    expect(s.answered).toBe(2);
    expect(s.correct).toBe(1);
    expect(s.dismissed).toBe(1);
    expect(s.medianLatencyMs).toBe(9000);
  });
});

/* Item 43: grading authority degrades by level. answer() (recognition)
 * keeps working exactly as it always has — asserted again here, not just
 * assumed, since the whole point is that this path is unchanged. */
describe('level-dependent grading (item 43)', () => {
  const FREE_RECALL_Q = { ...QUESTION, level: 'free_recall' };
  const SCENARIO_Q = { ...QUESTION, level: 'scenario' };
  const ADVERSARIAL_Q = { ...QUESTION, level: 'adversarial' };

  it('answer() still records recognition as deterministic, unchanged', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION); // no level — defaults to recognition
    const rec = r.answer(0, QUESTION);
    expect(rec.gradingMethod).toBe('deterministic');
    expect(rec.level).toBe('recognition');
    expect(rec.correct).toBe(true);
  });

  it('answerGraded() records a model verdict at free_recall', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(FREE_RECALL_Q);
    const rec = r.answerGraded('the link is weak', 'correct', 'high');
    expect(rec.type).toBe('response');
    expect(rec.subtype).toBe('correct');
    expect(rec.correct).toBe(true);
    expect(rec.gradingMethod).toBe('model');
    expect(rec.level).toBe('free_recall');
    expect(rec.confidence).toBe('high');
    expect(rec.answerText).toBe('the link is weak');
  });

  it('answerGraded() records an incorrect verdict at free_recall', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(FREE_RECALL_Q);
    const rec = r.answerGraded('totally unrelated guess', 'incorrect', null);
    expect(rec.subtype).toBe('incorrect');
    expect(rec.correct).toBe(false);
  });

  it('answerGraded() normalises anything other than correct/incorrect to unknown, never a guess', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    for (const bogus of [undefined, null, '', 'maybe', 'CORRECT', 42]) {
      r.present(SCENARIO_Q);
      const rec = r.answerGraded('an answer', bogus, null);
      expect(rec.subtype).toBe('unknown');
      expect(rec.correct).toBeNull();
    }
  });

  it('answerGraded() at scenario carries level "scenario" so state-engine.js can refuse to assert wrong from it', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(SCENARIO_Q);
    const rec = r.answerGraded('my reasoning', 'incorrect', null);
    // response-signals.js itself does not refuse this shape — the refusal
    // is state-engine.js's job (see state-engine.test.js) — but the record
    // must carry enough for that refusal to be possible at all.
    expect(rec.level).toBe('scenario');
    expect(rec.subtype).toBe('incorrect');
  });

  it('respond() at adversarial is never graded — no verdict, correct stays null', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(ADVERSARIAL_Q);
    const rec = r.respond('here is my counter-argument');
    expect(rec.subtype).toBe('ungraded');
    expect(rec.correct).toBeNull();
    expect(rec.gradingMethod).toBe('none');
    expect(rec.level).toBe('adversarial');
    expect(rec.answerText).toBe('here is my counter-argument');
  });

  it('respond() is distinct from dismiss() — the reader engaged, they did not decline', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(ADVERSARIAL_Q);
    const rec = r.respond('an argument');
    expect(rec.subtype).not.toBe('dismissed');
  });

  it('truncates an overlong answer text defensively, even though the real cap is enforced upstream', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(FREE_RECALL_Q);
    const huge = 'x'.repeat(10000);
    const rec = r.answerGraded(huge, 'unknown', null);
    expect(rec.answerText.length).toBeLessThanOrEqual(500);
  });

  it('answerGraded()/respond() ignore the call when nothing was asked, like answer()/dismiss() already do', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    expect(r.answerGraded('x', 'correct', null)).toBeNull();
    expect(r.respond('x')).toBeNull();
  });

  it('an unrecognised level in the question falls back to recognition rather than inventing a fifth', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present({ ...QUESTION, level: 'omniscient' });
    const rec = r.answer(0, QUESTION);
    expect(rec.level).toBe('recognition');
  });
});

/* The signal hierarchy from CLAUDE.md, made testable: reader responses are
 * the only ground truth and outrank everything else. */
describe('responses outrank reading signals in the engine', () => {
  it('a wrong answer is struggling, above any reading-signal confidence', () => {
    const engine = createReadingStateEngine();
    const viaSignal = createReadingStateEngine().update({
      reading: { type: 'speed_mismatch', subtype: 'too_slow', actualWpm: 90, baselineWpm: 225 },
    });
    const viaAnswer = engine.update({
      reading: { type: 'response', subtype: 'incorrect', correct: false },
    });

    expect(viaAnswer.label).toBe(STATES.STRUGGLING);
    expect(viaAnswer.confidence).toBeGreaterThan(viaSignal.confidence);
    expect(viaAnswer.evidence[0]).toMatch(/different answer/);
  });

  it('a correct answer overrides a reading signal that said struggling', () => {
    const engine = createReadingStateEngine();
    const s = engine.update({
      reading: [
        { type: 'speed_mismatch', subtype: 'too_slow', actualWpm: 90, baselineWpm: 225 },
        { type: 'response', subtype: 'correct', correct: true },
      ],
    });
    // The reader demonstrably understood it. The slow reading was fine.
    expect(s.label).toBe(STATES.ON_PACE);
    expect(s.evidence[0]).toMatch(/answered that correctly/);
  });

  it('a correct answer earns no interruption', () => {
    const engine = createReadingStateEngine();
    // random: () => 1 disables exploration sampling for this assertion — the
    // question here is whether a correct answer's resulting on_pace state
    // earns an interruption on its own merits, not a probabilistic one.
    const policy = createInterventionPolicy({ random: () => 1 });
    const s = engine.update({ reading: { type: 'response', subtype: 'correct', correct: true } });
    expect(policy.evaluate(s).allow).toBe(false);
  });

  it('a dismissal asserts nothing at all', () => {
    const engine = createReadingStateEngine();
    const s = engine.update({
      reading: { type: 'response', subtype: 'dismissed', correct: null },
    });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('a wrong answer does not immediately trigger another question', () => {
    const clock = fixedClock();
    const engine = createReadingStateEngine({ now: clock.now });
    const policy = createInterventionPolicy({ now: clock.now });

    // The question that was asked cost an interruption.
    const first = engine.update({ reading: { type: 'backtrack', backtrackPx: 200 } });
    const d1 = policy.evaluate(first, {});
    expect(d1.allow).toBe(true);
    policy.record(d1);

    // They got it wrong. That is real, and it still waits its turn.
    clock.advance(5000);
    const after = engine.update({ reading: { type: 'response', subtype: 'incorrect', correct: false } });
    expect(after.label).toBe(STATES.STRUGGLING);
    expect(policy.evaluate(after, {}).allow).toBe(false);
  });
});

/* Item S6/E4 follow-up: paragraphIndex/questionId are additive context
 * carried from present() onto every record — used downstream by host.js
 * to report outcomes against a specific assignment (see that file's own
 * header). Both null-safe for every existing caller that never sets
 * them — asserted here directly since ordinary (non-assignment) reading
 * must stay completely unaffected. */
describe('paragraphIndex/questionId context (item S6/E4 follow-up)', () => {
  it('present() with no paragraphIndex/questionId in context leaves both null on the record — every pre-existing caller', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphKey: 'p1' });
    const rec = r.answer(0, QUESTION);
    expect(rec.paragraphIndex).toBeNull();
    expect(rec.questionId).toBeNull();
  });

  it('present() carries paragraphIndex/questionId through to answer()', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphKey: 'p1', paragraphIndex: 4, questionId: 'q-fingerprint-1' });
    const rec = r.answer(0, QUESTION);
    expect(rec.paragraphIndex).toBe(4);
    expect(rec.questionId).toBe('q-fingerprint-1');
  });

  it('carries through answerGraded() (free_recall/scenario) too', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present({ ...QUESTION, level: 'scenario' }, { paragraphIndex: 2, questionId: 'q-2' });
    const rec = r.answerGraded('an answer', 'correct', 'high');
    expect(rec.paragraphIndex).toBe(2);
    expect(rec.questionId).toBe('q-2');
  });

  it('carries through respond() (adversarial) too', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present({ ...QUESTION, level: 'adversarial' }, { paragraphIndex: 9, questionId: 'q-9' });
    const rec = r.respond('an argument');
    expect(rec.paragraphIndex).toBe(9);
    expect(rec.questionId).toBe('q-9');
  });

  it('a non-integer paragraphIndex in context normalises to null, never trusted as-is', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphIndex: 'not-a-number', questionId: 'q-1' });
    const rec = r.answer(0, QUESTION);
    expect(rec.paragraphIndex).toBeNull();
  });
});
