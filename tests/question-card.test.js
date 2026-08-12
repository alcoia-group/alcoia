// @vitest-environment jsdom
/* Two things pinned here at the card level, since nothing else in the suite
 * renders the actual DOM:
 *
 * 1. A correct answer ends the interaction — confirmation only, never the
 *    explanation (the project notes, product intent). The explanation path is the
 *    failure path, reached only on a wrong answer.
 * 2. Confidence is captured at commit time, alongside the answer, not as a
 *    post-answer probe — clicking an option only selects it; grading and
 *    reveal happen once, from the confidence step (the project notes, confidence
 *    calibration).
 */
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

function pick(root, index) {
  root.querySelector(`.sra-q-option[data-index="${index}"]`).click();
}
function rate(root, level) {
  if (level === null) root.querySelector('.sra-q-conf-skip').click();
  else root.querySelector(`.sra-q-conf-btn[data-conf="${level}"]`).click();
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('selecting an option', () => {
  it('does not grade or commit — it only opens the confidence step', () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);

    expect(onAnswered).not.toHaveBeenCalled();
    expect(ui.root.querySelector('.sra-q-result')).toBeNull();
    expect(ui.root.querySelector('.sra-q-option[data-index="0"]').disabled).toBe(false);
    expect(ui.root.querySelector('.sra-q-confidence')).toBeTruthy();
  });

  it('marks the tentative pick without marking correct/wrong', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 1);

    const opt = ui.root.querySelector('.sra-q-option[data-index="1"]');
    expect(opt.classList.contains('sra-q-selected')).toBe(true);
    expect(opt.classList.contains('sra-q-correct')).toBe(false);
    expect(opt.classList.contains('sra-q-wrong')).toBe(false);
  });

  it('changing the pick before committing counts as a revise, not two answers', () => {
    const ui = fakeUI();
    const responseSignals = createResponseSignals();
    const reviseSpy = vi.spyOn(responseSignals, 'revise');
    const card = createQuestionCard({
      ui, esc, responseSignals, onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    expect(reviseSpy).not.toHaveBeenCalled(); // first pick is not a revision
    pick(ui.root, 1);
    expect(reviseSpy).toHaveBeenCalledTimes(1);
    pick(ui.root, 1); // clicking the same option again is not a revision
    expect(reviseSpy).toHaveBeenCalledTimes(1);
  });
});

describe('committing without rating confidence', () => {
  it('is one click away ("Rather not say") and grades normally', () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, null);

    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(onAnswered.mock.calls[0][0].confidence).toBeNull();
    expect(ui.root.querySelector('.sra-q-confidence')).toBeNull();
    expect(ui.root.querySelector('.sra-q-result').textContent).not.toMatch(/spells out the right answer/);
  });
});

describe('a correct answer', () => {
  it('shows a bare confirmation and never the explanation text', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, null);

    const result = ui.root.querySelector('.sra-q-result');
    expect(result).toBeTruthy();
    expect(result.classList.contains('sra-q-result-correct')).toBe(true);
    expect(result.textContent).not.toMatch(/spells out the right answer/);
    expect(ui.root.querySelector('.sra-q-span')).toBeNull();
    expect(ui.root.querySelector('.sra-q-option[data-index="0"]').disabled).toBe(true);
  });

  it('never fetches or renders the fuller explanation', async () => {
    const ui = fakeUI();
    const fetchExplanation = vi.fn(async () => 'more detail');
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), fetchExplanation,
      onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, 'high');
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchExplanation).not.toHaveBeenCalled();
    expect(ui.root.querySelector('.sra-q-explain')).toBeNull();
  });

  it('carries no praise beyond a neutral confirmation', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, null);

    const text = ui.root.querySelector('.sra-q-result').textContent;
    expect(text).not.toMatch(/great|nice|well done|good job/i);
  });

  it.each(['high', 'low'])('with %s confidence, still shows no explanation', (level) => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, level);

    const result = ui.root.querySelector('.sra-q-result');
    expect(result.classList.contains('sra-q-result-correct')).toBe(true);
    expect(result.textContent).not.toMatch(/spells out the right answer/);
  });
});

describe('a wrong answer', () => {
  it('shows the inline explanation and the quoted span', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 1);
    rate(ui.root, null);

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
    pick(ui.root, 1);
    rate(ui.root, null);
    await vi.waitFor(() => expect(fetchExplanation).toHaveBeenCalledWith(QUESTION.span));

    await vi.waitFor(() => expect(ui.root.querySelector('.sra-q-explain')?.textContent).toBe('more detail'));
  });
});

/* Item 19: 2-4 load-bearing terms highlighted in the explanation, never in
 * the question/options/quoted span, never on the correct-answer path. */
describe('keyword highlighting', () => {
  it('highlights terms in the inline explanation on a wrong answer', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 1);
    rate(ui.root, null);

    const result = ui.root.querySelector('.sra-q-result');
    expect(result.innerHTML).toContain('class="sra-term"');
  });

  it('never highlights anything on a correct answer', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, null);

    expect(ui.root.querySelector('.sra-term')).toBeNull();
  });

  it('never highlights anything in the question text or the options', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    expect(ui.root.querySelector('.sra-q-text .sra-term')).toBeNull();
    for (const opt of ui.root.querySelectorAll('.sra-q-option')) {
      expect(opt.querySelector('.sra-term')).toBeNull();
      expect(opt.classList.contains('sra-term')).toBe(false);
    }
  });

  it('never highlights inside the quoted span — that is the passage, not the system\'s own words', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 1);
    rate(ui.root, null);

    const span = ui.root.querySelector('.sra-q-span');
    expect(span).toBeTruthy();
    expect(span.querySelector('.sra-term')).toBeNull();
  });

  it('highlights the fuller fetched explanation too, on the failure path', async () => {
    const ui = fakeUI();
    const fetchExplanation = vi.fn(async () =>
      'The measurement apparatus in the laboratory was noisy and imprecise throughout the experiment.');
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), fetchExplanation,
      onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 1);
    rate(ui.root, null);
    await vi.waitFor(() => expect(ui.root.querySelector('.sra-q-explain')?.innerHTML).toContain('sra-term'));
  });

  it('never wraps more than 4 terms', () => {
    const ui = fakeUI();
    const longExplanation = {
      ...QUESTION,
      explanation: 'Aardvark biology chemistry dinosaur elephant flamingo giraffe hedgehog '
        + 'important journey kangaroo lighthouse mountain notebook orchestra painting.',
    };
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(longExplanation);
    pick(ui.root, 1);
    rate(ui.root, null);

    const count = ui.root.querySelectorAll('.sra-term').length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('never introduces unescaped HTML even if the explanation contained markup-like text', () => {
    const ui = fakeUI();
    const hostile = {
      ...QUESTION,
      explanation: '<img src=x onerror=alert(1)> the measurement apparatus was noisy in the laboratory',
    };
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(hostile);
    pick(ui.root, 1);
    rate(ui.root, null);

    expect(ui.root.querySelector('img')).toBeNull();
    expect(ui.root.querySelector('.sra-q-result').innerHTML).toContain('&lt;img');
  });
});

/* the project notes' confidence-calibration table, at the card level: the four
 * combinations render distinct copy, and wrong+high is never harsher in
 * tone than wrong+low. */
describe('calibration copy', () => {
  const cases = [
    { index: 0, level: 'high', expect: /appropriately confident/ },
    { index: 0, level: 'low',  expect: /knew more than you thought/ },
    { index: 1, level: 'high', expect: /you were sure/ },
    { index: 1, level: 'low',  expect: /weren't sure/ },
  ];

  it.each(cases)('answer index $index at $level confidence gets its own copy', ({ index, level, expect: pattern }) => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, index);
    rate(ui.root, level);

    expect(ui.root.querySelector('.sra-q-result').textContent).toMatch(pattern);
  });

  it('wrong+high carries no harsher tone than wrong+low', () => {
    const scold = /wrong|bad|shouldn't have|overconfident|too sure of yourself/i;
    for (const level of ['high', 'low']) {
      const ui = fakeUI();
      const card = createQuestionCard({
        ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
      });
      card.show(QUESTION);
      pick(ui.root, 1);
      rate(ui.root, level);
      expect(ui.root.querySelector('.sra-q-result').textContent).not.toMatch(scold);
    }
  });

  it('passes the confidence through to the response record', () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed: () => {},
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, 'high');

    expect(onAnswered.mock.calls[0][0].confidence).toBe('high');
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

  it('is still available while the confidence step is open, and is not scored', () => {
    const ui = fakeUI();
    const onAnswered = vi.fn();
    const onDismissed = vi.fn();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed,
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    expect(ui.root.querySelector('.sra-q-confidence')).toBeTruthy();
    ui.root.querySelector('.sra-close-btn').click();

    expect(onAnswered).not.toHaveBeenCalled();
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});

/* Item 18: reachable from "the intervention card itself... the moment a
 * reader most wants it is when one has just appeared". */
describe('snooze', () => {
  it('does not render a snooze control when onSnooze is not provided', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
    });
    card.show(QUESTION);
    expect(ui.root.querySelector('.sra-q-snooze-toggle')).toBeNull();
  });

  it('is available before any option is picked', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
      onSnooze: () => {},
    });
    card.show(QUESTION);
    expect(ui.root.querySelector('.sra-q-snooze-toggle')).toBeTruthy();
  });

  it('reveals a fixed, small set of durations on click', () => {
    const ui = fakeUI();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
      onSnooze: () => {},
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-q-snooze-toggle').click();
    const buttons = ui.root.querySelectorAll('.sra-q-snooze-options button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons.length).toBeLessThanOrEqual(4);
  });

  it('choosing a duration calls onSnooze with a positive duration and dismisses the card', () => {
    const ui = fakeUI();
    const onSnooze = vi.fn();
    const onDismissed = vi.fn();
    const onAnswered = vi.fn();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered, onDismissed, onSnooze,
    });
    card.show(QUESTION);
    ui.root.querySelector('.sra-q-snooze-toggle').click();
    ui.root.querySelector('.sra-q-snooze-options button').click();

    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(onSnooze.mock.calls[0][0]).toBeGreaterThan(0);
    expect(typeof onSnooze.mock.calls[0][1]).toBe('string');
    // Snoozing counts as a dismissal for item 10's backoff — this is the
    // same dismiss() path "Skip this" and the close button already use, not
    // a second bookkeeping call.
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onAnswered).not.toHaveBeenCalled();
  });

  it('is still offered after answering, for pausing future reminders — and does not double-count as a dismissal since the card was already answered', () => {
    const ui = fakeUI();
    const onSnooze = vi.fn();
    const onDismissed = vi.fn();
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed, onSnooze,
    });
    card.show(QUESTION);
    pick(ui.root, 0);
    rate(ui.root, null);

    const toggle = ui.root.querySelector('.sra-q-snooze-toggle');
    expect(toggle).toBeTruthy();
    toggle.click();
    ui.root.querySelector('.sra-q-snooze-options button').click();

    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(onDismissed).not.toHaveBeenCalled(); // already answered, not dismissed
  });
});
