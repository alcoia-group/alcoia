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

/* Evidence-silo fix (intelligence-architecture audit, step 2): quiz.js runs
 * in a separate tab from every existing caller of this module (host.js's
 * question card and session-recall review flow) and now uses this exact
 * same present()/answer()/answerGraded()/respond() API, tagged source:
 * 'quiz'. This module itself does not merge histories or know about
 * documents — see host.js's pickLevel()/readQuizEvidence() for that. What
 * belongs here is only: the field exists, defaults correctly for every
 * existing (inline) caller, and survives on every record shape this module
 * can produce. */
describe('source (evidence-silo fix, step 2)', () => {
  it("defaults to 'inline' when a caller never sets it — every pre-existing caller, unchanged", () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphKey: 'p1' });
    expect(r.answer(0, QUESTION).source).toBe('inline');
  });

  it("is 'quiz' only when a caller explicitly passes it, never inferred another way", () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphKey: 'p1', source: 'quiz' });
    expect(r.answer(0, QUESTION).source).toBe('quiz');
  });

  it("an unrecognised source value falls back to 'inline' rather than being passed through as-is", () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { source: 'something-else' });
    expect(r.answer(0, QUESTION).source).toBe('inline');
  });

  it('carries through every record-producing function, not just answer()', () => {
    const graded = createResponseSignals({ now: fixedClock().now });
    graded.present({ ...QUESTION, level: 'free_recall' }, { source: 'quiz' });
    expect(graded.answerGraded('an answer', 'correct', 'high').source).toBe('quiz');

    const responded = createResponseSignals({ now: fixedClock().now });
    responded.present({ ...QUESTION, level: 'adversarial' }, { source: 'quiz' });
    expect(responded.respond('an argument').source).toBe('quiz');

    const dismissed = createResponseSignals({ now: fixedClock().now });
    dismissed.present(QUESTION, { source: 'quiz' });
    expect(dismissed.dismiss().source).toBe('quiz');
  });

  it('history() preserves each record\'s own source when inline and quiz-tagged records are mixed', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphKey: 'inline-concept' });
    r.answer(0, QUESTION);
    r.present(QUESTION, { paragraphKey: 'quiz-concept', source: 'quiz' });
    r.answer(0, QUESTION);

    const sources = r.history().map((h) => h.source);
    expect(sources).toEqual(['inline', 'quiz']);
  });
});

/* Intelligence-architecture audit, step 5 — interventionId, and the real
 * concurrency bug it fixes: host.js's questionCard is shared by handleAsk
 * (orchestrator-triggered) and runSessionRecall (reader-initiated), and
 * ui-controller.js's own MAX_POPUPS is 5, not 1 — a second question card CAN
 * genuinely render while a first is still open, unanswered. Before this
 * item, `present()` unconditionally overwrote the single `asked` slot, so
 * answering the FIRST of two such cards after the second had rendered
 * silently produced null (a dropped outcome) rather than the first card's
 * real answer. THE REGRESSION PROOF below reproduces exactly that. */
describe('interventionId and concurrent pending interventions (step 5)', () => {
  it('present() attaches interventionId onto the returned/stored record when the caller supplies one', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    const asked = r.present(QUESTION, { interventionId: 'iv_1' });
    expect(asked.interventionId).toBe('iv_1');
  });

  it('interventionId is null when the caller never supplies one — every pre-step-5 caller, unchanged', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    const asked = r.present(QUESTION);
    expect(asked.interventionId).toBeNull();
  });

  it('every terminal record (answer/answerGraded/respond/dismiss) carries the interventionId it was presented with', () => {
    const a = createResponseSignals({ now: fixedClock().now });
    a.present(QUESTION, { interventionId: 'iv_a' });
    expect(a.answer(0, QUESTION).interventionId).toBe('iv_a');

    const b = createResponseSignals({ now: fixedClock().now });
    b.present({ ...QUESTION, level: 'free_recall' }, { interventionId: 'iv_b' });
    expect(b.answerGraded('x', 'correct', 'high').interventionId).toBe('iv_b');

    const c = createResponseSignals({ now: fixedClock().now });
    c.present({ ...QUESTION, level: 'adversarial' }, { interventionId: 'iv_c' });
    expect(c.respond('an argument').interventionId).toBe('iv_c');

    const d = createResponseSignals({ now: fixedClock().now });
    d.present(QUESTION, { interventionId: 'iv_d' });
    expect(d.dismiss().interventionId).toBe('iv_d');
  });

  it('THE REGRESSION PROOF: two concurrently pending interventions (present() called twice before either is answered) can each be resolved correctly, in either order, once each carries its own interventionId', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    // Card A presented (e.g. handleAsk's inline ask)...
    r.present(QUESTION, { interventionId: 'iv_A', paragraphKey: 'para-A' });
    // ...then card B presented BEFORE A was answered (e.g. runSessionRecall
    // rendering a review question while the inline card is still open) —
    // the exact scenario ui-controller.js's MAX_POPUPS=5 makes possible.
    r.present({ ...QUESTION, q: 'A different question' }, { interventionId: 'iv_B', paragraphKey: 'para-B' });

    // The reader answers B first (it rendered more recently, on top).
    const recordB = r.answer(1, { ...QUESTION, answerIndex: 1 }, 'high', 'iv_B');
    expect(recordB).not.toBeNull();
    expect(recordB.interventionId).toBe('iv_B');
    expect(recordB.paragraphKey).toBe('para-B');

    // THE BUG THIS FIXES: before interventionId-keyed resolution existed,
    // `asked` had already been overwritten by B's present() call and then
    // cleared by B's own answer() — so resolving A here would have
    // returned null, silently dropping a real answer. It now resolves A's
    // own still-pending record correctly.
    const recordA = r.answer(0, QUESTION, 'low', 'iv_A');
    expect(recordA).not.toBeNull();
    expect(recordA.interventionId).toBe('iv_A');
    expect(recordA.paragraphKey).toBe('para-A');
    expect(recordA.correct).toBe(true);

    expect(r.history()).toHaveLength(2);
  });

  it('does not cross-link: answering A never uses B\'s question/level/span, and vice versa', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    const questionA = { ...QUESTION, span: 'span for A', answerIndex: 0 };
    const questionB = { ...QUESTION, span: 'span for B', answerIndex: 2 };
    r.present(questionA, { interventionId: 'iv_A' });
    r.present(questionB, { interventionId: 'iv_B' });

    const recordA = r.answer(0, questionA, null, 'iv_A');
    const recordB = r.answer(2, questionB, null, 'iv_B');

    expect(recordA.span).toBe('span for A');
    expect(recordA.correct).toBe(true);
    expect(recordB.span).toBe('span for B');
    expect(recordB.correct).toBe(true);
  });

  it('intervention A presented, then B presented, then only B is answered — A is never incorrectly resolved as if it were B, and stays cleanly pending/unresolved', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { interventionId: 'iv_A' });
    r.present({ ...QUESTION, span: 'span for B' }, { interventionId: 'iv_B' });

    const recordB = r.answer(0, QUESTION, null, 'iv_B');
    expect(recordB.interventionId).toBe('iv_B');
    expect(recordB.span).toBe('span for B');

    // Only one record was ever produced — B's. A was never resolved,
    // never merged into B's record, and never silently attributed to it
    // merely because A happened first.
    expect(r.history()).toHaveLength(1);
    expect(r.history()[0].interventionId).toBe('iv_B');
  });

  it('a dismiss on one pending intervention does not resolve or clear a different one', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { interventionId: 'iv_A' });
    r.present(QUESTION, { interventionId: 'iv_B' });

    const dismissedA = r.dismiss('iv_A');
    expect(dismissedA.interventionId).toBe('iv_A');

    const recordB = r.answer(0, QUESTION, null, 'iv_B');
    expect(recordB).not.toBeNull();
    expect(recordB.interventionId).toBe('iv_B');
  });

  it('an interventionId that does not resolve to anything pending (already resolved, or never presented) returns null rather than falling back to the shared `asked` slot', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { interventionId: 'iv_A' });
    // A real, different pending intervention exists in `asked`, but a
    // caller asking for an unrelated, unknown id must never accidentally
    // resolve to it.
    expect(r.answer(0, QUESTION, null, 'iv_unknown')).toBeNull();
    // The real pending one is untouched and still resolvable normally.
    expect(r.answer(0, QUESTION, null, 'iv_A')).not.toBeNull();
  });

  it('revise()/markScrollBack() target the correct pending record under concurrency too', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { interventionId: 'iv_A' });
    r.present(QUESTION, { interventionId: 'iv_B' });

    r.revise('iv_A');
    r.revise('iv_A');
    r.markScrollBack('iv_B');

    const recordA = r.answer(0, QUESTION, null, 'iv_A');
    const recordB = r.answer(0, QUESTION, null, 'iv_B');
    expect(recordA.revisions).toBe(2);
    expect(recordA.scrolledBack).toBe(false);
    expect(recordB.revisions).toBe(0);
    expect(recordB.scrolledBack).toBe(true);
  });

  it('every pre-step-5 caller (no interventionId anywhere) still behaves exactly as a single-slot design — sequential present()/answer() pairs work unchanged', () => {
    const r = createResponseSignals({ now: fixedClock().now });
    r.present(QUESTION, { paragraphKey: 'p1' });
    const rec1 = r.answer(0, QUESTION);
    expect(rec1.interventionId).toBeNull();

    r.present(QUESTION, { paragraphKey: 'p2' });
    const rec2 = r.answer(0, QUESTION);
    expect(rec2.interventionId).toBeNull();

    expect(r.history()).toHaveLength(2);
  });
});
