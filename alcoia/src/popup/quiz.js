// quiz.js — the quiz page. One quiz per load: picks up a just-generated
// quiz handed off from content.js's runQuiz(), or resumes an incomplete one
// for the same document. Reuses question-card.js's confidence-commit flow
// and calibration copy so answering here behaves identically to the
// floating card — see calibration-copy.js.
import { createQuizStore } from '../content/quiz-store.js';
import { calibratedLine } from '../content/calibration-copy.js';

const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('logo-img').src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
$('logo-img-dark').src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
  document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
});
$('closeBtn').addEventListener('click', () => window.close());

const store = createQuizStore();
const root = $('quizRoot');
const documentKey = new URL(location.href).searchParams.get('key') || null;

function showEmpty(message) {
  $('progressRow').hidden = true;
  $('progressTrack').hidden = true;
  root.innerHTML = `<div class="quiz-card"><div class="empty-state"><p>${esc(message)}</p></div></div>`;
}

function updateProgress(index, total) {
  $('progressRow').hidden = false;
  $('progressTrack').hidden = false;
  $('progressText').textContent = `Question ${index + 1} of ${total}`;
  $('progressFill').style.width = `${Math.round(((index) / total) * 100)}%`;
}

/* One question at a time, reusing the popup card's own markup and CSS
 * classes (overlay.css) so this behaves identically to question-card.js:
 * picking an option only selects it; the confidence step commits and
 * grades; a correct answer gets confirmation only, never the explanation,
 * at any confidence level (item 12/13's rules apply here unchanged). */
function renderQuestion(record, index) {
  const question = record.questions[index];
  updateProgress(index, record.questions.length);

  root.innerHTML = `
    <div class="quiz-card">
      <div class="sra-q-text">${esc(question.q)}</div>
      <div class="sra-q-options">
        ${question.options.map((opt, i) =>
          `<button class="sra-q-option" data-index="${i}">${esc(opt)}</button>`).join('')}
      </div>
    </div>`;

  const card = root.querySelector('.quiz-card');
  let selected = null;
  let committed = false;

  function showConfidenceStep() {
    if (committed || card.querySelector('.sra-q-confidence')) return;
    const step = document.createElement('div');
    step.className = 'sra-q-confidence';
    step.innerHTML = `
      <div class="sra-q-confidence-label">How sure are you?</div>
      <div class="sra-q-confidence-options">
        <button type="button" class="sra-q-conf-btn" data-conf="low">Not sure</button>
        <button type="button" class="sra-q-conf-btn" data-conf="high">Pretty sure</button>
        <button type="button" class="sra-q-conf-skip">Rather not say</button>
      </div>`;
    card.appendChild(step);
    step.querySelector('[data-conf="low"]').onclick = () => commit('low');
    step.querySelector('[data-conf="high"]').onclick = () => commit('high');
    step.querySelector('.sra-q-conf-skip').onclick = () => commit(null);
  }

  async function commit(confidence) {
    if (committed || selected === null) return;
    committed = true;
    card.querySelector('.sra-q-confidence')?.remove();

    const correct = selected === question.answerIndex;
    for (const btn of card.querySelectorAll('.sra-q-option')) {
      const i = Number(btn.dataset.index);
      btn.disabled = true;
      btn.classList.remove('sra-q-selected');
      if (i === question.answerIndex) btn.classList.add('sra-q-correct');
      else if (i === selected) btn.classList.add('sra-q-wrong');
    }

    const calibrated = calibratedLine(correct, confidence);
    const note = document.createElement('div');
    note.className = correct ? 'sra-q-result sra-q-result-correct' : 'sra-q-result sra-q-result-wrong';
    note.innerHTML = correct
      ? `<span class="sra-q-check" aria-hidden="true">✓</span><strong>${esc(calibrated || "That's right.")}</strong>`
      : `<strong>${esc(calibrated || 'Not quite.')}</strong>${question.explanation ? ` ${esc(question.explanation)}` : ''}
         ${question.span ? `<div class="sra-q-span">“${esc(question.span)}”</div>` : ''}`;
    card.appendChild(note);

    await store.recordAnswer(record.id, {
      questionIndex: index, chosenIndex: selected, correct, confidence, answeredAt: Date.now(),
    });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-primary';
    nextBtn.style.marginTop = '16px';
    nextBtn.textContent = index + 1 < record.questions.length ? 'Next question' : 'See results';
    nextBtn.onclick = async () => {
      if (index + 1 < record.questions.length) {
        renderQuestion(record, index + 1);
      } else {
        const completed = await store.complete(record.id);
        renderResults(completed);
      }
    };
    card.appendChild(nextBtn);
  }

  for (const btn of card.querySelectorAll('.sra-q-option')) {
    btn.onclick = () => {
      if (committed) return;
      selected = Number(btn.dataset.index);
      for (const b of card.querySelectorAll('.sra-q-option')) {
        b.classList.toggle('sra-q-selected', Number(b.dataset.index) === selected);
      }
      showConfidenceStep();
    };
  }
}

/* Plain factual tally — "4 of 6 correct" — never a percentage or any
 * language implying it measures comprehension (the project notes, claims
 * discipline: no accuracy figure, anywhere). Each row expands only what
 * item 12/13 already allow: nothing extra on a correct answer, the
 * explanation and span on a wrong one. */
function renderResults(record) {
  $('progressRow').hidden = true;
  $('progressTrack').hidden = true;

  const byIndex = new Map(record.answers.map((a) => [a.questionIndex, a]));
  const correctCount = record.answers.filter((a) => a.correct).length;

  const rows = record.questions.map((q, i) => {
    const a = byIndex.get(i);
    const correct = !!a?.correct;
    return `
      <div class="result-row">
        <div class="result-row-top">
          <span class="result-mark ${correct ? 'correct' : 'wrong'}">${correct ? '✓' : '✕'}</span>
          <span class="result-q">${esc(q.q)}</span>
        </div>
        ${!correct && q.explanation ? `<div class="result-explain">${esc(q.explanation)}</div>` : ''}
        ${!correct && q.span ? `<div class="result-span">“${esc(q.span)}”</div>` : ''}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="quiz-card">
      <div class="results-tally">${correctCount} of ${record.questions.length} correct</div>
      <p class="results-label">This document only — nothing here is compared across sessions or documents.</p>
      <div class="results-list">${rows}</div>
      <div class="footer-actions">
        <button class="danger-link" id="deleteThisBtn">Delete this quiz</button>
        <button class="danger-link" id="deleteAllBtn">Delete all my quizzes</button>
      </div>
    </div>`;

  $('deleteThisBtn').onclick = async () => {
    await store.deleteOne(record.id);
    showEmpty('This quiz has been deleted.');
  };
  $('deleteAllBtn').onclick = async () => {
    await store.deleteAll();
    showEmpty('All quiz history has been deleted.');
  };
}

async function boot() {
  if (!documentKey) { showEmpty('No quiz to show — go back to the article and use "Take the quiz".'); return; }

  const pending = await new Promise((resolve) =>
    chrome.storage.local.get({ sra_quiz_pending: null }, (res) => resolve(res.sra_quiz_pending)));

  let record = null;
  if (pending && pending.key === documentKey && Array.isArray(pending.questions) && pending.questions.length) {
    record = await store.save({ documentKey, questions: pending.questions });
    await new Promise((resolve) => chrome.storage.local.remove('sra_quiz_pending', resolve));
  } else {
    const existing = await store.listForDocument(documentKey);
    record = existing.find((r) => !r.completedAt) || null;
  }

  if (!record) { showEmpty('No quiz ready yet — go back to the article and use "Take the quiz".'); return; }

  const nextIndex = record.answers.length; // resume where a reader left off
  if (nextIndex >= record.questions.length) {
    renderResults(record.completedAt ? record : await store.complete(record.id));
  } else {
    renderQuestion(record, nextIndex);
  }
}

boot();
