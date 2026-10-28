// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { whyFor } from '../alcoia/src/shared/why-this.js';
import { t, UI_LANGS } from '../alcoia/src/shared/i18n.js';
import { createQuestionCard } from '../alcoia/src/content/question-card.js';
import { createResponseSignals } from '../alcoia/src/content/signals/response-signals.js';
import { esc } from '../alcoia/src/content/ui-controller.js';

const KEYS = ['why.toggle', 'why.slow', 'why.reread', 'why.hard', 'why.review', 'why.transfer', 'why.probe', 'why.return', 'why.focus', 'why.explain', 'why.repair', 'why.recall', 'why.off'];

describe('whyFor', () => {
  it('reads the reason from what actually happened', () => {
    expect(whyFor('ask', { evidence: ['You read this 1.8x slower than your usual pace'] }).key).toBe('why.slow');
    expect(whyFor('ask', { evidence: ['You scrolled back 400px to re-read'] }).key).toBe('why.reread');
    expect(whyFor('ask', { evidence: ["You said you're stuck or don't get it"] }).key).toBe('why.hard');
    expect(whyFor('ask', { evidence: [] }).key).toBe('why.hard');
  });
  it('gives a reason for every automatic kind, and says a requested review was requested', () => {
    for (const k of ['explain', 'repair', 'retention', 'transfer', 'probe', 'return_check']) expect(whyFor(k).auto).toBe(true);
    expect(whyFor('retention', { focus: true }).key).toBe('why.focus');
    expect(whyFor('session_recall')).toEqual({ key: 'why.recall', auto: false });
  });
  it('an unknown kind gives no reason, so no line is shown', () => {
    expect(whyFor('selected_text')).toBeNull();
  });
  it('every reason and the toggle exist in all twelve languages, with no em dash', () => {
    for (const lang of UI_LANGS) for (const key of KEYS) {
      const text = t(key, lang);
      expect(text, `${lang} ${key}`).not.toBe(key);
      expect(text).not.toContain(String.fromCharCode(8212));
    }
  });
});

function setup() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ui = { reservePopup: () => root, showPopup: () => {}, closePopup: (el) => el.remove(), flashPopup: () => {} };
  const card = createQuestionCard({ ui, esc, responseSignals: createResponseSignals(), fetchExplanation: async () => '', fetchGrading: async () => null, onAnswered() {}, onDismissed() {} });
  return { root, card };
}
const Q = { q: 'What did it say?', options: ['A', 'B', 'C', 'D'], answerIndex: 0, explanation: 'x', span: 'The passage says A, clearly and in full.' };

describe('"Why am I seeing this?" on a card', () => {
  beforeEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; });
  it('is closed by default, opens on click, and an automatic card also says where to turn these off', () => {
    const { root, card } = setup();
    expect(card.show(Q, { why: { key: 'why.slow', auto: true } })).toBe(true);
    const btn = root.querySelector('.sra-q-why-toggle');
    const box = root.querySelector('.sra-q-why-text');
    expect(btn.textContent).toBe('Why am I seeing this?');
    expect(box.hasAttribute('hidden')).toBe(true);
    btn.click();
    expect(box.hasAttribute('hidden')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(box.textContent).toContain('You took longer on this paragraph than usual.');
    expect(box.textContent).toContain('turn these off');
  });
  it('a card the reader asked for does not mention turning it off', () => {
    const { root, card } = setup();
    card.show(Q, { why: { key: 'why.recall', auto: false } });
    expect(root.querySelector('.sra-q-why-text').textContent).not.toContain('turn these off');
  });
  it('no reason, no line; an unknown key is ignored', () => {
    const a = setup();
    a.card.show(Q, {});
    expect(a.root.querySelector('.sra-q-why')).toBeNull();
    document.body.innerHTML = '';
    const b = setup();
    b.card.show(Q, { why: { key: 'why.nonsense', auto: true } });
    expect(b.root.querySelector('.sra-q-why')).toBeNull();
  });
  it('an explanation card carries it too, and it does not name a card type', () => {
    const { root, card } = setup();
    card.showExplanation('repair', 'A plainer way to see it.', { why: { key: 'why.repair', auto: true } });
    expect(root.querySelector('.sra-q-why-text').textContent).toMatch(/plainer explanation/);
    expect(root.textContent).not.toMatch(/repair|retention|probe|transfer check/i);
  });
});
