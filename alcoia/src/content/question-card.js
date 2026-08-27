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
 *    interface instead of the passage (CLAUDE.md, confidence calibration).
 *    So clicking an option only *selects* it; committing — which grades it
 *    and reveals the result — happens once, in the confidence step below,
 *    with whatever confidence (or none, it is skippable) the reader gave.
 *
 * Item 43 — grading authority now degrades by level (CLAUDE.md, signal
 * hierarchy). `recognition` keeps the exact flow above: pick one of four
 * options, graded deterministically and instantly. The other three levels
 * cannot be multiple-choice — free_recall and scenario have answers a model
 * has to judge, and adversarial's whole point is the reader's own argument —
 * so they get a free-text input instead, alongside the SAME confidence
 * control. What happens after commit differs by level:
 *   free_recall / scenario   the answer is sent for grading (fetchGrading,
 *                             host.js) and the verdict — correct, incorrect,
 *                             or unknown — decides what's shown. scenario's
 *                             fetchGrading() call structurally cannot return
 *                             "incorrect" (see that file), so this module
 *                             never has an "assert wrong" branch to reach
 *                             for it in the first place.
 *   adversarial               never sent anywhere. The system acknowledges
 *                             the argument; it does not mark it.
 * Nothing here ever renders raw model output as HTML: the grader returns a
 * verdict enum, not prose, and every string this file puts in the DOM is
 * either fixed copy or passed through esc()/renderHighlightedExplanation()
 * exactly as the recognition path already did.
 */

import { calibratedLine } from './calibration-copy.js';
import { SNOOZE_OPTIONS } from './snooze.js';
import { renderHighlightedExplanation } from './keyword-highlight.js';
import { gradedResultMarkup, respondedResultMarkup } from './graded-result.js';

const GRADED_LEVELS = ['free_recall', 'scenario'];
const FREE_TEXT_LEVELS = ['free_recall', 'scenario', 'adversarial'];
// Mirrors tests/contract/grading.js's MAX_ANSWER_CHARS — enforced here via
// the textarea's own maxlength (the reader physically cannot type past it)
// AND again in commit() below, so nothing bypasses it via a pasted value.
const MAX_ANSWER_CHARS = 500;

/* Wrong answers are not scolded. The reader gets the correct option marked,
 * the sentence it came from, and an offer of a fuller explanation. */
export function createQuestionCard(deps = {}) {
  const {
    ui,                 // reservePopup / showPopup / closePopup / flashPopup
    esc,
    responseSignals,
    fetchExplanation,   // async (spanText) => string
    fetchGrading,       // async ({ passage, span, spanRole, question, answer, level }) => { verdict, span } — item 43
    onAnswered,         // (record) => void — hands the signal to the engine
    onDismissed,        // (record) => void
    onSnooze,           // (durationMs, label) => void — item 18
  } = deps;

  /* question: { q, options[4], answerIndex, explanation, span, level?, span_role? }
   * context: { evidence[], anchorRect, paragraphKey, passage?, wasExplorationSample }
   * Returns true only if the card actually reached the screen.
   *
   * Malformed model output degrades to silence here, not to a broken card.
   * A response that passed the server's own validation could still arrive
   * truncated or reshaped by a network failure between there and here, and
   * the shape checked below is exactly what the rest of this function reads
   * without a further guard. Any one of those missing used to mean either an
   * uncaught exception or a card reading literally "undefined" to the person
   * looking at it — worse than showing nothing, which is what invariant 9
   * asks for. recognition keeps its original, unchanged shape check; the
   * other three levels need q + span (the citation discipline item 42
   * already enforces server-side) and nothing about options/answerIndex,
   * since they are never shown multiple choice at those levels. */
  function show(question, context = {}) {
    if (!question || typeof question.q !== 'string' || !question.q.trim()) return false;

    const level = FREE_TEXT_LEVELS.includes(question.level) ? question.level : 'recognition';

    if (level === 'recognition') {
      if (!Array.isArray(question.options) || question.options.length !== 4
        || question.options.some((o) => typeof o !== 'string' || !o.trim())
        || !Number.isInteger(question.answerIndex)
        || question.answerIndex < 0 || question.answerIndex > 3
      ) return false;
    } else if (typeof question.span !== 'string' || !question.span.trim()) {
      return false;
    }

    const fingerprint = 'q-' + (question.span || question.q).slice(0, 80).trim();
    const root = ui.reservePopup(fingerprint);
    if (!root) return false;

    // Item S6/E4 follow-up: reuses this SAME popup-dedup fingerprint as
    // the outcome-reporting question_id, rather than inventing a second
    // identity for the same question — there is no question id anywhere
    // else in this system (questions are generated on the fly, never
    // persisted server-side). See response-signals.js's own header.
    responseSignals.present(question, { ...context, questionId: fingerprint });

    const evidence = context.evidence && context.evidence.length
      ? `<div class="sra-q-evidence">${esc(context.evidence[0])}.</div>`
      : '';

    const bodyInner = level === 'recognition'
      ? `<div class="sra-q-options">
          ${question.options.map((opt, i) =>
            `<button class="sra-q-option" data-index="${i}">${esc(opt)}</button>`).join('')}
        </div>`
      : `<div class="sra-q-freetext">
          <textarea class="sra-q-answer-input" maxlength="${MAX_ANSWER_CHARS}" rows="3" placeholder="Type your answer…"></textarea>
          <div class="sra-q-answer-count"><span class="sra-q-answer-count-num">0</span>/${MAX_ANSWER_CHARS}</div>
        </div>`;

    root.innerHTML = `
      <div class="sra-controls">
        <button class="sra-ctrl-btn sra-close-btn" title="Dismiss">✕</button>
      </div>
      <div class="sra-popup-body">
        <div class="sra-state-badge sra-q-badge">quick check</div>
        ${evidence}
        <div class="sra-q-text">${esc(question.q)}</div>
        ${bodyInner}
      </div>
      <div class="sra-popup-divider"></div>
      <div class="sra-actions">
        <button class="sra-btn sra-btn-secondary sra-q-skip">Skip this</button>
        ${onSnooze ? '<button type="button" class="sra-q-snooze-toggle">Snooze reminders</button>' : ''}
      </div>`;

    let committed = false;
    let selected = null; // tentative pick — recognition only, not yet graded

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
     * has just appeared (CLAUDE.md, snooze) — but it stays offered after
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

    /* Shared by every level — only what happens on commit (below) differs.
     * Called once, from the confidence step, with whatever confidence —
     * 'low', 'high', or null (skipped) — the reader gave alongside it. */
    function showConfidenceStep(onCommit) {
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
      step.querySelector('[data-conf="low"]').onclick = () => onCommit('low');
      step.querySelector('[data-conf="high"]').onclick = () => onCommit('high');
      step.querySelector('.sra-q-conf-skip').onclick = () => onCommit(null);
    }

    function finish() {
      const skip = root.querySelector('.sra-q-skip');
      if (skip) { skip.textContent = 'Close'; skip.onclick = () => ui.closePopup(root, fingerprint); }
    }

    if (level === 'recognition') {
      /* Grades and reveals. Deterministic, unchanged from before item 43. */
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

        finish();
      };

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
          showConfidenceStep(commit);
        };
      }
    } else {
      /* free_recall / scenario / adversarial — free text. */
      const textarea = root.querySelector('.sra-q-answer-input');
      const countEl = root.querySelector('.sra-q-answer-count-num');
      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'sra-btn sra-btn-primary sra-q-submit-text';
      submitBtn.textContent = 'Submit';
      submitBtn.disabled = true;
      root.querySelector('.sra-actions').prepend(submitBtn);

      textarea.addEventListener('input', () => {
        const len = textarea.value.length;
        if (countEl) countEl.textContent = String(len);
        submitBtn.disabled = len === 0;
      });

      const commit = async (confidence) => {
        if (committed) return;
        const answerText = textarea.value.trim().slice(0, MAX_ANSWER_CHARS);
        if (!answerText) return;
        committed = true;
        root.querySelector('.sra-q-confidence')?.remove();
        submitBtn.remove();

        if (level === 'adversarial') {
          // Never graded, never sent anywhere — the system acknowledges the
          // argument; it does not mark it.
          const record = responseSignals.respond(answerText);
          if (record && onAnswered) onAnswered(record);
          revealResponded(root);
          finish();
          return;
        }

        const working = document.createElement('div');
        working.className = 'sra-q-explain';
        working.textContent = 'Checking your answer…';
        body.appendChild(working);

        // Every failure here — no fetchGrading wired up, a thrown error, a
        // response that failed shape validation inside fetchGrading itself
        // — degrades to the same 'unknown' verdict (invariant 9), never a
        // thrown error reaching the reader as a broken card.
        let graded = { verdict: 'unknown', span: null };
        try {
          if (fetchGrading) {
            graded = await fetchGrading({
              passage: context.passage || '',
              span: question.span,
              spanRole: level === 'scenario' ? 'principle' : 'answer',
              question: question.q,
              answer: answerText,
              level,
            }) || graded;
          }
        } catch (e) { /* graded stays 'unknown' */ }
        working.remove();

        // Third, independent guard against ever showing the READER a false
        // "wrong" at scenario — host.js's fetchGrading() and
        // tests/contract/grading.js's validateGradingResponse() both already
        // refuse to produce this, but THIS is the one place that decides
        // what actually reaches the screen, so it does not rely solely on
        // either of those having held. The cost of getting this specific
        // check wrong is a reader who reasoned well being told they were
        // wrong — unrecoverable, per this item's own reasoning — so it is
        // checked here too, not assumed from upstream.
        const verdict = level === 'scenario' && graded.verdict === 'incorrect' ? 'unknown' : graded.verdict;

        const record = responseSignals.answerGraded(answerText, verdict, confidence);
        if (record && onAnswered) onAnswered(record);

        revealGraded(root, question, verdict, level, esc);

        // Only free_recall can ever reach here with subtype 'incorrect' —
        // fetchGrading() structurally cannot return "incorrect" for
        // scenario (see host.js and tests/contract/grading.js), and the
        // guard just above catches it a third time even if that ever slips,
        // so this condition is never true there in the first place, not merely
        // guarded against being acted on.
        if (record && record.subtype === 'incorrect') {
          offerExplanation(root, question, fetchExplanation, esc);
        }

        finish();
      };

      submitBtn.onclick = () => {
        if (committed || !textarea.value.trim()) return;
        // Locks the answer at the moment of submitting, before the
        // confidence step — the same moment revision stops being possible
        // in the multiple-choice flow (selecting a different option is
        // fine right up until the confidence step appears).
        textarea.disabled = true;
        submitBtn.disabled = true;
        showConfidenceStep(commit);
      };
    }

    ui.showPopup(root, context.anchorRect || null);
    return true;
  }

  return { show, GRADED_LEVELS };
}

/* Mark the options and show the sentence the answer came from. The span is
 * the reason the server insists on a verbatim citation — without it this
 * would just be an assertion.
 *
 * A correct answer ends the interaction: confirmation only, never
 * `question.explanation`, never the quoted span, whether or not confidence
 * was given. Explaining something the reader just demonstrated they know
 * adds load at the exact moment of consolidation and trains them to expect
 * the system to do the closing work (CLAUDE.md, product intent). The
 * explanation path is the failure path — reached only below, on a wrong
 * answer — and is never the default, regardless of confidence either.
 *
 * The explanation text (not the question, not the options, not the quoted
 * span — that is the passage itself) gets 2-4 load-bearing terms
 * highlighted, sage, the same as everywhere else the system marks its own
 * emphasis. See keyword-highlight.js for why this never runs on the
 * correct-answer branch: it is only ever called from the `!correct` half
 * below. */
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
    : `<strong>${esc(calibrated || 'Not quite.')}</strong>${question.explanation ? ` ${renderHighlightedExplanation(question.explanation, esc)}` : ''}
       ${question.span ? `<div class="sra-q-span">“${esc(question.span)}”</div>` : ''}`;
  body.appendChild(note);
}

/* Item 43: reveals a MODEL-GRADED verdict — free_recall or scenario.
 * Three fixed, hardcoded copy branches keyed on the verdict enum; nothing
 * the model wrote is ever inserted here as markup. The span shown (on an
 * incorrect verdict, or on a scenario "unknown") is `question.span` — the
 * ORIGINAL, server-validated span this card was already given when the
 * question was generated (item 42), already run through esc() exactly like
 * the recognition path — never the grader's own echoed copy of it, which
 * this function does not even look at.
 *
 * scenario can only ever arrive here as 'correct' or 'unknown' — never
 * 'incorrect' (see commit()'s own comment) — so its "unknown" copy
 * deliberately reads as neutral, not as a near-miss: confirm or say
 * nothing, never a false correction (CLAUDE.md, item 43's whole reason to
 * exist). free_recall's "unknown" copy is worded the same way, for the same
 * reason — an inconclusive grade is not evidence of a wrong answer either. */
function revealGraded(root, question, verdict, level, esc) {
  const body = root.querySelector('.sra-popup-body');
  if (!body) return;
  const { className, innerHTML } = gradedResultMarkup({ verdict, level, question, esc });
  const note = document.createElement('div');
  note.className = className;
  note.innerHTML = innerHTML;
  body.appendChild(note);
}

/* Item 43: adversarial's whole reveal — see graded-result.js's
 * respondedResultMarkup(), shared with quiz.js. */
function revealResponded(root) {
  const body = root.querySelector('.sra-popup-body');
  if (!body) return;
  const { className, innerHTML } = respondedResultMarkup();
  const note = document.createElement('div');
  note.className = className;
  note.innerHTML = innerHTML;
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
    // This fuller explanation is also failure-path-only (offerExplanation is
    // only ever called from the !record.correct/'incorrect' branch in
    // show()), so it gets the same highlighting treatment as the inline
    // explanation above.
    holder.innerHTML = text ? `<div>${renderHighlightedExplanation(text, esc)}</div>` : '';
    if (!text) holder.remove();
  } catch (e) {
    holder.remove();
  }
}
