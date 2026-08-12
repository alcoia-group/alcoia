/* question-card.js — the retrieval question, in front of the reader
 *
 * The primary intervention. Answering is what produces the only ground truth
 * in the system, so this is the card that matters; the summary popup is the
 * fallback for when a question could not be generated or was answered wrong.
 *
 * Three rules that are not negotiable in here:
 *
 * 1. The reader can always leave. Dismissing is one click, it is never scored
 *    as a wrong answer, and no question is ever asked twice for the same
 *    paragraph. Being tested against your will is the thing that makes
 *    software like this hated.
 * 2. The card shows what was observed before it asks anything — the same
 *    evidence line every other interruption carries. The reader should be able
 *    to see why they were interrupted and disagree with it.
 * 3. Confidence is captured at commit time, alongside the answer — not as a
 *    post-answer "are you sure?" probe. A probe that surfaces more often
 *    after wrong answers leaks the result, and readers learn to read the
 *    interface instead of the passage (the project notes, confidence calibration).
 *    So clicking an option only *selects* it; committing — which grades it
 *    and reveals the result — happens once, in the confidence step below,
 *    with whatever confidence (or none, it is skippable) the reader gave.
 */

import { calibratedLine } from './calibration-copy.js';
import { SNOOZE_OPTIONS } from './snooze.js';

/* Wrong answers are not scolded. The reader gets the correct option marked,
 * the sentence it came from, and an offer of a fuller explanation. */
export function createQuestionCard(deps = {}) {
  const {
    ui,                 // reservePopup / showPopup / closePopup / flashPopup
    esc,
    responseSignals,
    fetchExplanation,   // async (spanText) => string
    onAnswered,         // (record) => void — hands the signal to the engine
    onDismissed,        // (record) => void
    onSnooze,           // (durationMs, label) => void — item 18
  } = deps;

  /* question: { q, options[4], answerIndex, explanation, span }
   * Returns true only if the card actually reached the screen.
   *
   * Malformed model output degrades to silence here, not to a broken card.
   * A response that passed the server's own validation could still arrive
   * truncated or reshaped by a network failure between there and here, and
   * the shape checked below is exactly what the rest of this function reads
   * without a further guard — `q` and `options` are rendered as text,
   * `answerIndex` selects one of `options`, and `span || q` seeds the
   * dedup fingerprint. Any one of those missing used to mean either an
   * uncaught exception (`undefined.slice()` on the fingerprint) or a card
   * reading literally "undefined" to the person looking at it — worse than
   * showing nothing, which is what invariant 9 asks for. */
  function show(question, context = {}) {
    if (!question
      || typeof question.q !== 'string' || !question.q.trim()
      || !Array.isArray(question.options) || question.options.length !== 4
      || question.options.some((o) => typeof o !== 'string' || !o.trim())
      || !Number.isInteger(question.answerIndex)
      || question.answerIndex < 0 || question.answerIndex > 3
    ) return false;

    const fingerprint = 'q-' + (question.span || question.q).slice(0, 80).trim();
    const root = ui.reservePopup(fingerprint);
    if (!root) return false;

    responseSignals.present(question, context);

    const evidence = context.evidence && context.evidence.length
      ? `<div class="sra-q-evidence">${esc(context.evidence[0])}.</div>`
      : '';

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn sra-close-btn" title="Dismiss">✕</button>
      </div>
      <div class="sra-popup-body">
        <div class="sra-state-badge sra-q-badge">quick check</div>
        ${evidence}
        <div class="sra-q-text">${esc(question.q)}</div>
        <div class="sra-q-options">
          ${question.options.map((opt, i) =>
            `<button class="sra-q-option" data-index="${i}">${esc(opt)}</button>`).join('')}
        </div>
      </div>
      <div class="sra-popup-divider"></div>
      <div class="sra-actions">
        <button class="sra-btn sra-btn-secondary sra-q-skip">Skip this</button>
        ${onSnooze ? '<button type="button" class="sra-q-snooze-toggle">Snooze reminders</button>' : ''}
      </div>`;

    let committed = false;
    let selected = null; // tentative pick — not yet graded

    const dismiss = () => {
      if (!committed) {
        const record = responseSignals.dismiss();
        if (record && onDismissed) onDismissed(record);
      }
      ui.closePopup(root, fingerprint);
    };

    root.querySelector('.sra-close-btn').onclick = dismiss;
    root.querySelector('.sra-q-skip').onclick = dismiss;

    const body = root.querySelector('.sra-popup-body');

    /* The moment a reader most wants to pause reminders is the moment one
     * has just appeared (the project notes, snooze) — but it stays offered after
     * answering too, for "stop bothering me for a while" once this one is
     * done. Choosing a duration routes through the same dismiss() path
     * "Skip this" uses: before an answer that records the dismissal (item
     * 10's backoff); after one, dismiss() is a no-op beyond closing the
     * card, since answering already counted as engagement, not evasion. */
    const snoozeToggle = root.querySelector('.sra-q-snooze-toggle');
    if (snoozeToggle) {
      snoozeToggle.onclick = () => {
        if (root.querySelector('.sra-q-snooze-options')) return;
        const panel = document.createElement('div');
        panel.className = 'sra-q-snooze-options';
        panel.innerHTML = `
          <span class="sra-q-snooze-label">Pause reminders for:</span>
          ${SNOOZE_OPTIONS.map((o) => `<button type="button" data-snooze="${o.id}">${esc(o.label)}</button>`).join('')}`;
        // Appended to the body, not .sra-actions — that row is a non-wrapping
        // flex row and this needs its own line underneath it.
        body.appendChild(panel);
        for (const opt of SNOOZE_OPTIONS) {
          panel.querySelector(`[data-snooze="${opt.id}"]`).onclick = () => {
            onSnooze(opt.durationMs(Date.now()), opt.label);
            dismiss();
          };
        }
      };
    }

    /* Grades and reveals. Called once, from the confidence step, with
     * whatever confidence — 'low', 'high', or null (skipped) — the reader
     * gave alongside the commit. */
    const commit = (confidence) => {
      if (committed || selected === null) return;
      committed = true;
      root.querySelector('.sra-q-confidence')?.remove();

      const record = responseSignals.answer(selected, question, confidence);
      if (record && onAnswered) onAnswered(record);

      revealAnswer(root, question, selected, confidence, esc);

      if (record && !record.correct) {
        offerExplanation(root, question, fetchExplanation, esc);
      }

      const skip = root.querySelector('.sra-q-skip');
      if (skip) { skip.textContent = 'Close'; skip.onclick = () => ui.closePopup(root, fingerprint); }
    };

    function showConfidenceStep() {
      if (committed || root.querySelector('.sra-q-confidence')) return;
      const step = document.createElement('div');
      step.className = 'sra-q-confidence';
      step.innerHTML = `
        <div class="sra-q-confidence-label">How sure are you?</div>
        <div class="sra-q-confidence-options">
          <button type="button" class="sra-q-conf-btn" data-conf="low">Not sure</button>
          <button type="button" class="sra-q-conf-btn" data-conf="high">Pretty sure</button>
          <button type="button" class="sra-q-conf-skip">Rather not say</button>
        </div>`;
      body.appendChild(step);
      step.querySelector('[data-conf="low"]').onclick = () => commit('low');
      step.querySelector('[data-conf="high"]').onclick = () => commit('high');
      step.querySelector('.sra-q-conf-skip').onclick = () => commit(null);
    }

    for (const btn of root.querySelectorAll('.sra-q-option')) {
      btn.onclick = () => {
        if (committed) return;
        const i = Number(btn.dataset.index);
        // Changing your mind before committing is hesitation, not an answer.
        if (selected !== null && selected !== i) responseSignals.revise();
        selected = i;
        for (const b of root.querySelectorAll('.sra-q-option')) {
          b.classList.toggle('sra-q-selected', Number(b.dataset.index) === i);
        }
        showConfidenceStep();
      };
    }

    ui.showPopup(root, context.anchorRect || null);
    return true;
  }

  return { show };
}

/* Mark the options and show the sentence the answer came from. The span is
 * the reason the server insists on a verbatim citation — without it this
 * would just be an assertion.
 *
 * A correct answer ends the interaction: confirmation only, never
 * `question.explanation`, never the quoted span, whether or not confidence
 * was given. Explaining something the reader just demonstrated they know
 * adds load at the exact moment of consolidation and trains them to expect
 * the system to do the closing work (the project notes, product intent). The
 * explanation path is the failure path — reached only below, on a wrong
 * answer — and is never the default, regardless of confidence either. */
function revealAnswer(root, question, chosen, confidence, esc) {
  for (const btn of root.querySelectorAll('.sra-q-option')) {
    const i = Number(btn.dataset.index);
    btn.disabled = true;
    btn.classList.remove('sra-q-selected');
    if (i === question.answerIndex) btn.classList.add('sra-q-correct');
    else if (i === chosen) btn.classList.add('sra-q-wrong');
  }

  const body = root.querySelector('.sra-popup-body');
  if (!body) return;

  const correct = chosen === question.answerIndex;
  // A reader who committed without rating confidence gets the bare path —
  // confidence rating is skippable and must not gate grading on anything.
  const calibrated = calibratedLine(correct, confidence);

  const note = document.createElement('div');
  note.className = correct ? 'sra-q-result sra-q-result-correct' : 'sra-q-result sra-q-result-wrong';
  note.innerHTML = correct
    ? `<span class="sra-q-check" aria-hidden="true">✓</span><strong>${esc(calibrated || "That's right.")}</strong>`
    : `<strong>${esc(calibrated || 'Not quite.')}</strong>${question.explanation ? ` ${esc(question.explanation)}` : ''}
       ${question.span ? `<div class="sra-q-span">“${esc(question.span)}”</div>` : ''}`;
  body.appendChild(note);
}

async function offerExplanation(root, question, fetchExplanation, esc) {
  if (!fetchExplanation) return;
  const body = root.querySelector('.sra-popup-body');
  if (!body) return;

  const holder = document.createElement('div');
  holder.className = 'sra-q-explain';
  holder.textContent = 'Working through it…';
  body.appendChild(holder);

  try {
    // Scoped to the span, not the whole paragraph — the reader missed one
    // specific thing and that is what to explain.
    const text = await fetchExplanation(question.span || question.q);
    holder.innerHTML = text ? `<div>${esc(text)}</div>` : '';
    if (!text) holder.remove();
  } catch (e) {
    holder.remove();
  }
}
