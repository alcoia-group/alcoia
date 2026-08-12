// @vitest-environment jsdom
/* A correct answer ends the interaction — confirmation only, never the
 * explanation (the project notes, product intent). The explanation path is the
 * failure path, reached only on a wrong answer. This pins that split at the
 * card level, since nothing else in the suite renders the actual DOM. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQuestionCard } from '../alcoia/src/content/question-card.js';
import { createResponseSignals } from '../alcoia/src/content/telemetry/response-signals.js';
import { esc } from '../alcoia/src/content/ui-controller.js';

function fakeUI() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    root,
    reservePopup: () => root,
    showPopup: () => {},
    closePopup: (el) => { el.remove(); },
    flashPopup: () => {},
  };
}

const QUESTION = {
  q: 'What did the passage say?',
  options: ['Right answer', 'Wrong one', 'Also wrong', 'Still wrong'],
  answerIndex: 0,
  explanation: 'The passage spells out the right answer in detail.',
  span: 'The passage spells out the right answer in detail, right here.',
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('a correct answer', () => {
  it('shows a bare confirmation and never the explanation text', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(),
      onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-q-option[data-index="0"]').click();

    const result = ui.root.querySelector('.sra-q-result');
    expect(result).toBeTruthy();
    expect(result.classList.contains('sra-q-result-correct')).toBe(true);
    expect(result.textContent).not.toMatch(/spells out the right answer/);
    expect(ui.root.querySelector('.sra-q-span')).toBeNull();
  });

  it('never fetches or renders the fuller explanation', async () => {
    const ui = fakeUI();
    const fetchExplanation = vi.fn(async () => 'more detail');
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), fetchExplanation,
      onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-q-option[data-index="0"]').click();
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchExplanation).not.toHaveBeenCalled();
    expect(ui.root.querySelector('.sra-q-explain')).toBeNull();
  });

  it('carries no praise beyond a neutral confirmation', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(),
      onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-q-option[data-index="0"]').click();

    const text = ui.root.querySelector('.sra-q-result').textContent;
    expect(text).not.toMatch(/great|nice|well done|good job/i);
  });
});

describe('a wrong answer', () => {
  it('shows the inline explanation and the quoted span', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(),
      onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-q-option[data-index="1"]').click();

    const result = ui.root.querySelector('.sra-q-result');
    expect(result.classList.contains('sra-q-result-wrong')).toBe(true);
    expect(result.textContent).toMatch(/spells out the right answer/);
    expect(ui.root.querySelector('.sra-q-span')).toBeTruthy();
  });

  it('still offers a fuller explanation fetch, scoped to the span', async () => {
    const ui = fakeUI();
    const fetchExplanation = vi.fn(async () => 'more detail');
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), fetchExplanation,
      onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-q-option[data-index="1"]').click();
    await vi.waitFor(() => expect(fetchExplanation).toHaveBeenCalledWith(QUESTION.span));

    await vi.waitFor(() => expect(ui.root.querySelector('.sra-q-explain')?.textContent).toBe('more detail'));
  });
});

describe('dismissal', () => {
  it('never scores a dismissal as an answer', () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    const onDismissed = vi.fn();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed,
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-close-btn').click();

    expect(onAnswered).not.toHaveBeenCalled();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});
