// @vitest-environment jsdom
/* The words around alcoia's cards follow the language of the page. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t, tr, uiLang, resolveLang, isRtl, UI_LANGS, _internals } from '../alcoia/src/shared/i18n.js';
import { createQuestionCard } from '../alcoia/src/content/question-card.js';
import { createResponseSignals } from '../alcoia/src/content/signals/response-signals.js';
import { esc } from '../alcoia/src/content/ui-controller.js';
import { calibratedLine } from '../alcoia/src/content/calibration-copy.js';
import { gradedResultMarkup } from '../alcoia/src/content/graded-result.js';

const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');

describe('table', () => {
  it('covers the eleven requested languages plus English', () => {
    expect(UI_LANGS).toEqual(['en', 'fr', 'es', 'de', 'pt', 'it', 'nl', 'zh', 'ja', 'ko', 'ar', 'ru']);
  });

  it('has an entry for every key in every language, with the same placeholders as English', () => {
    for (const [key, row] of Object.entries(_internals.ROWS)) {
      expect(row.length, key).toBe(UI_LANGS.length);
      for (const [i, lang] of UI_LANGS.entries()) {
        expect(row[i].trim(), `${key}/${lang}`).not.toBe('');
        expect(vars(row[i]), `${key}/${lang}`).toBe(vars(row[0]));
      }
    }
  });
});

describe('lookup and fallback', () => {
  it('returns the word in the requested language', () => {
    expect(t('card.close', 'fr')).toBe('Fermer');
    expect(t('card.howSure', 'de')).toBe('Wie sicher bist du?');
    expect(t('card.close', 'ja')).toBe('閉じる');
  });

  it('falls back to English for a language it does not have, and to the key for an unknown key', () => {
    expect(t('card.close', 'sv')).toBe('Close');
    expect(t('card.close', undefined)).toBe('Close');
    expect(t('no.such.key', 'fr')).toBe('no.such.key');
  });

  it('fills placeholders', () => {
    expect(t('conn.connectsTo', 'fr', { title: 'Énergie' })).toBe('Lié à Énergie');
  });

  it('translates English text other modules still build, including lines with a number', () => {
    expect(tr('quick check', 'es')).toBe('comprobación rápida');
    expect(tr('You scrolled back 40px to re-read', 'de')).toBe('Du bist 40 px zurückgescrollt, um nochmal zu lesen');
    expect(tr('You went back 3 paragraphs to re-read', 'fr')).toContain('3 paragraphes');
    expect(tr('You went back a paragraph to review', 'es')).toContain('un párrafo');
    expect(tr('A quick check on what you just read.', 'fr')).toBe('Une vérification rapide sur ce que vous venez de lire.');
  });

  it('leaves unknown text and English pages alone', () => {
    expect(tr('Something else entirely', 'fr')).toBe('Something else entirely');
    expect(tr('quick check', 'en')).toBe('quick check');
  });
});

describe('which language', () => {
  afterEach(() => { document.documentElement.removeAttribute('lang'); document.body.innerHTML = ''; });

  it('maps a language tag to a supported language', () => {
    expect(resolveLang('fr-CA')).toBe('fr');
    expect(resolveLang('zh-Hant')).toBe('zh');
    expect(resolveLang('pt_BR')).toBe('pt');
    expect(resolveLang('sv')).toBe('en');
    expect(resolveLang(undefined)).toBe('en');
  });

  it('uses the lang attribute of the page first', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.documentElement.lang = 'es-MX';
    expect(uiLang(doc)).toBe('es');
  });

  it('falls back to the script of the text when the page has no lang attribute', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.body.innerHTML = `<p>${'Это длинный русский текст для проверки определения языка страницы. '.repeat(3)}</p>`;
    Object.defineProperty(doc.body, 'innerText', { value: doc.body.textContent });
    expect(uiLang(doc)).toBe('ru');
  });

  it('says only Arabic is right to left', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('fr')).toBe(false);
  });
});

describe('result lines', () => {
  it('translates the calibration and graded lines, and keeps English as the default', () => {
    expect(calibratedLine(true, 'high')).toBe('Correct, and appropriately confident.');
    expect(calibratedLine(true, 'high', 'fr')).toBe('Correct, et avec la bonne assurance.');
    expect(calibratedLine(false, null, 'fr')).toBeNull();
    expect(gradedResultMarkup({ verdict: 'correct', level: 'free_recall', question: {}, esc }).innerHTML).toContain('That looks right.');
    expect(gradedResultMarkup({ verdict: 'correct', level: 'free_recall', question: {}, esc, lang: 'fr' }).innerHTML).toContain('Cela semble juste.');
  });
});

describe('a question card on a French page', () => {
  beforeEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'fr'; });
  afterEach(() => { document.documentElement.removeAttribute('lang'); });

  const QUESTION = {
    q: 'Que dit le passage ?',
    options: ['Bonne réponse', 'Mauvaise', 'Aussi fausse', 'Encore fausse'],
    answerIndex: 0,
    explanation: 'Le passage donne la bonne réponse.',
    span: 'Le passage donne la bonne réponse, ici même.',
  };

  function setup() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ui = { reservePopup: () => root, showPopup() {}, closePopup: (el) => el.remove(), flashPopup() {} };
    const card = createQuestionCard({
      ui, esc, responseSignals: createResponseSignals(), onAnswered: () => {}, onDismissed: () => {},
      onSnooze: () => {}, onSelfReport: () => {},
    });
    return { root, card };
  }

  it('shows the fixed words in French and leaves the question as written', () => {
    const { root, card } = setup();
    card.show(QUESTION, { badge: 'from earlier', evidence: ['You scrolled back 40px to re-read'], showSelfReport: true });

    expect(root.querySelector('.sra-q-badge').textContent).toBe('vu plus tôt');
    expect(root.querySelector('.sra-q-evidence').textContent).toBe('Vous êtes remonté(e) de 40 px pour relire.');
    expect(root.querySelector('.sra-q-text').textContent).toBe('Que dit le passage ?');
    expect(root.querySelector('.sra-q-skip').textContent).toBe('Passer');
    expect(root.querySelector('.sra-q-snooze-toggle').textContent).toBe('Mettre les rappels en pause');
    expect(root.querySelector('.sra-self-report-prompt').textContent).toBe('Difficile à décrire ?');
    expect(root.querySelector('[data-self-report="confusion"]').textContent).toBe('Je bloque / je ne comprends pas');
    expect(root.querySelector('.sra-close-btn').title).toBe('Ignorer');

    root.querySelector('.sra-q-option[data-index="0"]').click();
    expect(root.querySelector('.sra-q-confidence-label').textContent).toBe('Êtes-vous sûr(e) ?');
    expect(root.querySelector('[data-conf="low"]').textContent).toBe('Pas sûr(e)');
    expect(root.querySelector('[data-conf="high"]').textContent).toBe('Assez sûr(e)');
    expect(root.querySelector('.sra-q-conf-skip').textContent).toBe('Je préfère ne pas répondre');

    root.querySelector('[data-conf="high"]').click();
    expect(root.querySelector('.sra-q-result').textContent).toContain('Correct, et avec la bonne assurance.');
    expect(root.querySelector('.sra-q-skip').textContent).toBe('Fermer');
  });

  it('shows the explanation card in French too', () => {
    const { root, card } = setup();
    card.showExplanation('repair', 'Une explication courte.', { evidence: ['You slowed down a lot here'], onFeedback: () => {} });
    expect(root.querySelector('.sra-explain-badge').textContent).toBe('pour y voir clair');
    expect(root.querySelector('.sra-q-evidence').textContent).toBe('Vous avez beaucoup ralenti ici.');
    expect(root.querySelector('.sra-q-helped-label').textContent).toBe('Cela vous a-t-il aidé ?');
    expect(root.querySelector('.sra-q-helped-no').textContent).toBe('Pas vraiment');
  });

  it('stays in English on an English page', () => {
    document.documentElement.lang = 'en';
    const { root, card } = setup();
    card.show(QUESTION, { evidence: ['You slowed down a lot here'] });
    expect(root.querySelector('.sra-q-badge').textContent).toBe('quick check');
    expect(root.querySelector('.sra-q-skip').textContent).toBe('Skip this');
    expect(root.querySelector('.sra-q-evidence').textContent).toBe('You slowed down a lot here.');
  });

  it('sets right-to-left for Arabic', () => {
    document.documentElement.lang = 'ar';
    const { root, card } = setup();
    card.show(QUESTION, {});
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(root.querySelector('.sra-q-skip').textContent).toBe('تخطَّ هذا');
  });
});
