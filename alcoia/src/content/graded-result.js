/* graded-result.js — the fixed copy shown for a model-graded verdict (item 43)
 *
 * Shared between question-card.js's floating card and quiz.js's own page so
 * a scenario "unknown" (or any other verdict) reads identically wherever a
 * reader answers a free-text question, and so the "never assert wrong at
 * scenario" wording lives in exactly one place rather than two copies that
 * could drift apart. Pure — returns { className, innerHTML } for the caller
 * to attach to its own DOM node; nothing here touches the document itself,
 * since the floating card and the quiz page each own their own result
 * element differently.
 *
 * Every string below is fixed copy, keyed only off the verdict enum and the
 * level — never off anything the grader wrote itself. The only per-question
 * content interpolated in is `question.span`/`question.explanation`, both
 * the client's own already-validated fields (item 42), run through the same
 * esc()/renderHighlightedExplanation() pipeline the recognition path always
 * used — never the grader's own echoed span.
 */
import { renderHighlightedExplanation } from './keyword-highlight.js';
import { t } from '../shared/i18n.js';

const escText = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function gradedResultMarkup({ verdict, level, question, esc, lang = 'en' }) {
  if (verdict === 'correct') {
    return {
      className: 'sra-q-result sra-q-result-correct',
      innerHTML: `<span class="sra-q-check" aria-hidden="true">✓</span><strong>${esc(t('res.looksRight', lang))}</strong>`,
    };
  }
  if (verdict === 'incorrect') {
    return {
      className: 'sra-q-result sra-q-result-wrong',
      innerHTML: `<strong>${esc(t('res.notQuite', lang))}</strong>${question.explanation ? ` ${renderHighlightedExplanation(question.explanation, esc)}` : ''}
         ${question.span ? `<div class="sra-q-span">“${esc(question.span)}”</div>` : ''}`,
    };
  }
  const spanLine = question.span ? `<div class="sra-q-span">“${esc(question.span)}”</div>` : '';
  return {
    className: 'sra-q-result sra-q-result-unknown',
    innerHTML: level === 'scenario'
      ? `<strong>${esc(t('res.cantConfirmEither', lang))}</strong> ${esc(t('res.principle', lang))}${spanLine}`
      : `<strong>${esc(t('res.cantConfirm', lang))}</strong>${spanLine}`,
  };
}

/* adversarial's whole reveal. No verdict, no correct/wrong styling — fixed
 * copy only, since there is nothing to grade and nothing was sent anywhere
 * to grade it. */
export function respondedResultMarkup(lang = 'en') {
  return {
    className: 'sra-q-result sra-q-result-responded',
    innerHTML: `<strong>${escText(t('res.notGraded', lang))}</strong> ${escText(t('res.pointIsArgue', lang))}`,
  };
}
