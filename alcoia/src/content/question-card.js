/* question-card.js — the retrieval question, in front of the reader
 *
 * The primary intervention. Answering is what produces the only ground truth
 * in the system, so this is the card that matters; the summary popup is the
 * fallback for when a question could not be generated or was answered wrong.
 *
 * Two rules that are not negotiable in here:
 *
 * 1. The reader can always leave. Dismissing is one click, it is never scored
 *    as a wrong answer, and no question is ever asked twice for the same
 *    paragraph. Being tested against your will is the thing that makes
 *    software like this hated.
 * 2. The card shows what was observed before it asks anything — the same
 *    evidence line every other interruption carries. The reader should be able
 *    to see why they were interrupted and disagree with it.
 */

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
      </div>`;

    let answered = false;

    const dismiss = () => {
      if (!answered) {
        const record = responseSignals.dismiss();
        if (record && onDismissed) onDismissed(record);
      }
      ui.closePopup(root, fingerprint);
    };

    root.querySelector('.sra-close-btn').onclick = dismiss;
    root.querySelector('.sra-q-skip').onclick = dismiss;

    let firstTouch = true;
    for (const btn of root.querySelectorAll('.sra-q-option')) {
      btn.onclick = async () => {
        if (answered) return;
        // A second look before committing is hesitation, not an answer.
        if (!firstTouch) responseSignals.revise();
        firstTouch = false;
        answered = true;

        const chosen = Number(btn.dataset.index);
        const record = responseSignals.answer(chosen, question);
        if (record && onAnswered) onAnswered(record);

        revealAnswer(root, question, chosen, esc);

        if (record && !record.correct) {
          await offerExplanation(root, question, fetchExplanation, esc);
        }

        const skip = root.querySelector('.sra-q-skip');
        if (skip) { skip.textContent = 'Close'; skip.onclick = () => ui.closePopup(root, fingerprint); }
      };
    }

    ui.showPopup(root, context.anchorRect || null);
    return true;
  }

  return { show };
}

/* Mark the options and show the sentence the answer came from. The span is
 * the reason the server insists on a verbatim citation — without it this
 * would just be an assertion. */
function revealAnswer(root, question, chosen, esc) {
  for (const btn of root.querySelectorAll('.sra-q-option')) {
    const i = Number(btn.dataset.index);
    btn.disabled = true;
    if (i === question.answerIndex) btn.classList.add('sra-q-correct');
    else if (i === chosen) btn.classList.add('sra-q-wrong');
  }

  const body = root.querySelector('.sra-popup-body');
  if (!body) return;

  const correct = chosen === question.answerIndex;
  const note = document.createElement('div');
  note.className = 'sra-q-result';
  note.innerHTML = correct
    ? `<strong>That's right.</strong>${question.explanation ? ` ${esc(question.explanation)}` : ''}`
    : `<strong>Not quite.</strong>${question.explanation ? ` ${esc(question.explanation)}` : ''}
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
