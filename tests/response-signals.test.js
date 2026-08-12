import { describe, it, expect } from 'vitest';
import { createResponseSignals } from '../alcoia/src/content/telemetry/response-signals.js';
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

/* The signal hierarchy from the project notes, made testable: reader responses are
 * the only ground truth and outrank everything else. */
describe('responses outrank telemetry in the engine', () => {
  it('a wrong answer is struggling, above any telemetry confidence', () => {
    const engine = createReadingStateEngine();
    const viaTelemetry = createReadingStateEngine().update({
      telemetry: { type: 'speed_mismatch', subtype: 'too_slow', actualWpm: 90, baselineWpm: 225 },
    });
    const viaAnswer = engine.update({
      telemetry: { type: 'response', subtype: 'incorrect', correct: false },
    });

    expect(viaAnswer.label).toBe(STATES.STRUGGLING);
    expect(viaAnswer.confidence).toBeGreaterThan(viaTelemetry.confidence);
    expect(viaAnswer.evidence[0]).toMatch(/different answer/);
  });

  it('a correct answer overrides telemetry that said struggling', () => {
    const engine = createReadingStateEngine();
    const s = engine.update({
      telemetry: [
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
    const s = engine.update({ telemetry: { type: 'response', subtype: 'correct', correct: true } });
    expect(policy.evaluate(s).allow).toBe(false);
  });

  it('a dismissal asserts nothing at all', () => {
    const engine = createReadingStateEngine();
    const s = engine.update({
      telemetry: { type: 'response', subtype: 'dismissed', correct: null },
    });
    expect(s.label).toBe(STATES.UNKNOWN);
  });

  it('a wrong answer does not immediately trigger another question', () => {
    const clock = fixedClock();
    const engine = createReadingStateEngine({ now: clock.now });
    const policy = createInterventionPolicy({ now: clock.now });

    // The question that was asked cost an interruption.
    const first = engine.update({ telemetry: { type: 'backtrack', backtrackPx: 200 } });
    const d1 = policy.evaluate(first, {});
    expect(d1.allow).toBe(true);
    policy.record(d1);

    // They got it wrong. That is real, and it still waits its turn.
    clock.advance(5000);
    const after = engine.update({ telemetry: { type: 'response', subtype: 'incorrect', correct: false } });
    expect(after.label).toBe(STATES.STRUGGLING);
    expect(policy.evaluate(after, {}).allow).toBe(false);
  });
});
