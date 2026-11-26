/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQuestionCard } from '../alcoia/src/content/question-card.js';
import { createResponseSignals } from '../alcoia/src/content/signals/response-signals.js';
import { esc } from '../alcoia/src/content/ui-controller.js';
import { createOutcomesManager } from '../alcoia/src/shared/outcomes.js';

// Phase 1 of the LearnHarness analysis: "Guessing", "I don't know", and the misunderstanding label behind a wrong pick.
function fakeUI() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { root, reservePopup: () => root, showPopup: () => {}, closePopup: (el) => el.remove(), flashPopup: () => {} };
}
const Q = {
  q: 'Why does ice float?',
  options: ['It is less dense than water', 'It is colder', 'It is lighter in total', 'It traps air'],
  answerIndex: 0,
  mistakes: ['', 'temperature decides floating', 'total weight decides floating', 'air bubbles decide floating'],
  explanation: 'Ice is less dense than liquid water.',
  span: 'Ice floats because it is less dense than liquid water.',
};
beforeEach(() => { document.body.innerHTML = ''; });

describe('confidence step', () => {
  it('offers Guessing and records it', () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    createQuestionCard({ ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed: () => {} }).show(Q);
    ui.root.querySelector('.sra-q-option[data-index="0"]').click();
    ui.root.querySelector('.sra-q-conf-btn[data-conf="guess"]').click();
    expect(onAnswered.mock.calls[0][0]).toMatchObject({ correct: true, confidence: 'guess' });
    expect(ui.root.querySelector('.sra-q-result').textContent).toContain('guessing');
  });
});

describe('wrong pick', () => {
  it('carries the misunderstanding label and asks for an explanation aimed at it', async () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    const fetchExplanation = vi.fn(async () => 'Density decides floating.');
    createQuestionCard({ ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed: () => {}, fetchExplanation }).show(Q);
    ui.root.querySelector('.sra-q-option[data-index="1"]').click();
    ui.root.querySelector('.sra-q-conf-btn[data-conf="high"]').click();
    expect(onAnswered.mock.calls[0][0].misconception).toBe('temperature decides floating');
    expect(fetchExplanation).toHaveBeenCalledWith(Q.span, { misconception: 'temperature decides floating' });
  });
  it('a question without labels explains as before', () => {
    const ui = fakeUI();
    const fetchExplanation = vi.fn(async () => 'x');
    createQuestionCard({ ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {}, fetchExplanation }).show({ ...Q, mistakes: undefined });
    ui.root.querySelector('.sra-q-option[data-index="1"]').click();
    ui.root.querySelector('.sra-q-conf-btn[data-conf="low"]').click();
    expect(fetchExplanation).toHaveBeenCalledWith(Q.span);
  });
});

describe("I don't know", () => {
  it('is an answered gap: no verdict, no confidence, shows what the reading says and offers an explanation', () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    const onDismissed = vi.fn();
    const fetchExplanation = vi.fn(async () => 'x');
    createQuestionCard({ ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed, fetchExplanation }).show(Q, { interventionId: 'iv1' });
    ui.root.querySelector('.sra-q-dontknow').click();
    expect(onDismissed).not.toHaveBeenCalled();
    expect(onAnswered.mock.calls[0][0]).toMatchObject({ subtype: 'dont_know', correct: null, dontKnow: true, confidence: null, interventionId: 'iv1' });
    expect(ui.root.querySelector('.sra-q-option[data-index="0"]').classList.contains('sra-q-correct')).toBe(true);
    expect(ui.root.querySelector('.sra-q-result-dontknow')).toBeTruthy();
    expect(fetchExplanation).toHaveBeenCalled();
    // a second click on anything does nothing
    ui.root.querySelector('.sra-q-option[data-index="1"]').click();
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });
  it('is not offered on an adversarial card', () => {
    const ui = fakeUI();
    createQuestionCard({ ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {} })
      .show({ q: 'Argue against it.', span: 'A claim worth arguing against.', level: 'adversarial' });
    expect(ui.root.querySelector('.sra-q-dontknow')).toBeNull();
  });
});

describe('outcome body', () => {
  const send = async (args) => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ recorded: true }) }));
    const m = createOutcomesManager({ fetchImpl, getSession: async () => ({ token: 't' }), outcomesUrl: 'https://x/o' });
    await m.submit({ paragraphIndex: 0, questionId: 'q1', ...args });
    return JSON.parse(fetchImpl.mock.calls[0][1].body);
  };
  it('sends guess as a confidence', async () => {
    expect((await send({ correct: true, confidence: 'guess' })).confidence).toBe('guess');
  });
  it("sends dont_know with no verdict and no confidence", async () => {
    const b = await send({ dontKnow: true, confidence: 'high' });
    expect(b.dont_know).toBe(true);
    expect(b.confidence).toBeUndefined();
    expect(b.correct).toBeUndefined();
  });
});

describe('misconception label on the outcome', () => {
  it('rides with a wrong option answer only', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ recorded: true }) }));
    const m = createOutcomesManager({ fetchImpl, getSession: async () => ({ token: 't' }), outcomesUrl: 'https://x/o' });
    await m.submit({ paragraphIndex: 0, questionId: 'q1', correct: false, selectedAnswer: 2, misconception: 'reverses the claim' });
    await m.submit({ paragraphIndex: 0, questionId: 'q1', correct: true, selectedAnswer: 0, misconception: 'reverses the claim' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).misconception).toBe('reverses the claim');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).misconception).toBeUndefined();
  });
});
