// quiz.js — the quiz page. One quiz per load: picks up a just-generated
// quiz handed off from content.js's runQuiz(), or resumes an incomplete one
// for the same document. Reuses question-card.js's confidence-commit flow
// and calibration copy so answering here behaves identically to the
// floating card — see calibration-copy.js.
//
// Item 43: a question here can arrive at any of the four levels, same as
// the floating card — recognition stays exactly as it always was, the
// other three get a free-text input and (for free_recall/scenario) a
// server-graded verdict instead of local grading. This page is a normal
// extension page, not host.js's content-script context, so it builds its
// own small instances of the same shared clients host.js uses
// (backend-client.js, grading-client.js) rather than reaching into host.js,
// which does not exist here. See those files' own headers for why they were
// pulled out of host.js in the first place.
import { createQuizStore } from '../content/quiz-store.js';
import { calibratedLine } from '../content/calibration-copy.js';
import { renderHighlightedExplanation } from '../content/keyword-highlight.js';
import { gradedResultMarkup, respondedResultMarkup } from '../content/graded-result.js';
import { createBackendClient } from '../shared/backend-client.js';
import { createGradingClient } from '../shared/grading-client.js';
import { createRateLimiter } from '../shared/rate-limit.js';
import { createSessionManager } from '../shared/session.js';
import { createOutcomesManager } from '../shared/outcomes.js';

const FREE_TEXT_LEVELS = ['free_recall', 'scenario', 'adversarial'];
// Mirrors tests/contract/grading.js's MAX_ANSWER_CHARS — enforced via the
// textarea's own maxlength AND again at commit time, so a pasted value
// cannot bypass it either.
const MAX_ANSWER_CHARS = 500;

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

// Item 13i: outcome reporting for a quiz taken on an assignment's own
// document — reuses item 9b's exact assignment-context mechanism rather
// than building a second one. assignmentId, when present, rides on this
// page's own URL the same way it already rides on the PDF viewer's
// (host.js's openQuizPage(), mirroring assignments.js's own pattern) —
// this page has no content-script context to inherit it from otherwise.
// On ordinary (non-assignment) reading this param is simply absent and
// submitQuizOutcome stays the no-op default below: no session manager, no
// outcomes manager, no network capability constructed at all — not merely
// unused.
const assignmentId = new URL(location.href).searchParams.get('assignmentId') || null;
let submitQuizOutcome = () => {};
if (assignmentId) {
  const outcomesSession = createSessionManager();
  const outcomesManager = createOutcomesManager({
    getSession: outcomesSession.getSession,
    outcomesUrl: `${self.ALCOIA_CONFIG.ASSIGNMENTS_URL}/${encodeURIComponent(assignmentId)}/outcomes`,
  });
  submitQuizOutcome = (fields) => {
    // Mirrors host.js's own submitOutcome guard exactly: a question with no
    // real paragraphIndex (session-recall.js had none recorded for it) is
    // silently not reported, never guessed at.
    if (!Number.isInteger(fields.paragraphIndex) || fields.paragraphIndex < 0) return;
    outcomesManager.submit({ ...fields, source: 'quiz' }).catch(() => {});
  };
}

// Set once boot() reads the sra_backend_url setting; falls back to
// config.js's default (loaded as a classic script before this module, same
// as popup.html does) until then and whenever the reader never set one.
let backendUrl = null;
const tokenUrl = () => {
  try { return new URL('/api/token', backendUrl || self.ALCOIA_CONFIG.SUMMARIZE_URL).href; }
  catch (e) { return self.ALCOIA_CONFIG.TOKEN_URL; }
};
const gradeUrl = () => (backendUrl || self.ALCOIA_CONFIG.SUMMARIZE_URL).replace(/\/api\/summarize\/?$/, '/api/grade');

const { callBackend } = createBackendClient({ getTokenUrl: tokenUrl });
// Own rate-limit bucket, same burst/ceiling shape as host.js's own
// AI_CALL_BURST_LIMIT/AI_CALL_CEILING_LIMIT (see that file) — this page has
// its own module instance and its own in-memory counters, not a budget
// shared with the content script.
const gradingRateLimiter = createRateLimiter({
  burstLimit: 6, burstWindowMs: 10_000, ceilingLimit: 30, ceilingWindowMs: 600_000,
});
const { fetchGrading } = createGradingClient({
  callBackend, getGradeUrl: gradeUrl, checkBudget: gradingRateLimiter.check,
});

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

function appendResultNote(card, className, innerHTML) {
  const note = document.createElement('div');
  note.className = className;
  note.innerHTML = innerHTML;
  card.appendChild(note);
  return note;
}

function appendNextButton(card, record, index) {
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

/* One question at a time, reusing the popup card's own markup and CSS
 * classes (overlay.css) so this behaves identically to question-card.js:
 * picking an option only selects it; the confidence step commits and
 * grades; a correct answer gets confirmation only, never the explanation,
 * at any confidence level. recognition keeps the exact deterministic flow
 * it always had; free_recall/scenario/adversarial get a free-text input
 * instead — see question-card.js's own header for what differs by level,
 * unchanged here. */
function renderQuestion(record, index) {
  const question = record.questions[index];
  updateProgress(index, record.questions.length);

  const level = FREE_TEXT_LEVELS.includes(question.level) ? question.level : 'recognition';

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
    <div class="quiz-card">
      <div class="sra-q-text">${esc(question.q)}</div>
      ${bodyInner}
    </div>`;

  const card = root.querySelector('.quiz-card');
  let selected = null;
  let committed = false;

  function showConfidenceStep(onCommit) {
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
    step.querySelector('[data-conf="low"]').onclick = () => onCommit('low');
    step.querySelector('[data-conf="high"]').onclick = () => onCommit('high');
    step.querySelector('.sra-q-conf-skip').onclick = () => onCommit(null);
  }

  if (level === 'recognition') {
    const commit = async (confidence) => {
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
      appendResultNote(card, correct ? 'sra-q-result sra-q-result-correct' : 'sra-q-result sra-q-result-wrong', correct
        ? `<span class="sra-q-check" aria-hidden="true">✓</span><strong>${esc(calibrated || "That's right.")}</strong>`
        : `<strong>${esc(calibrated || 'Not quite.')}</strong>${question.explanation ? ` ${renderHighlightedExplanation(question.explanation, esc)}` : ''}
           ${question.span ? `<div class="sra-q-span">“${esc(question.span)}”</div>` : ''}`);

      await store.recordAnswer(record.id, {
        questionIndex: index, chosenIndex: selected, correct, confidence,
        gradingMethod: 'deterministic', level: 'recognition', answeredAt: Date.now(),
      });
      // Item 13i: source:'quiz', added by submitQuizOutcome itself — a
      // no-op unless this quiz is on an assignment's document.
      // Item 13j-1: `selected` is the real chosen option index — the same
      // discrete-option identifier question-card.js's inline path sends.
      submitQuizOutcome({
        paragraphIndex: question.paragraphIndex, questionId: question.id, correct, confidence,
        selectedAnswer: selected,
      });

      appendNextButton(card, record, index);
    };

    for (const btn of card.querySelectorAll('.sra-q-option')) {
      btn.onclick = () => {
        if (committed) return;
        selected = Number(btn.dataset.index);
        for (const b of card.querySelectorAll('.sra-q-option')) {
          b.classList.toggle('sra-q-selected', Number(b.dataset.index) === selected);
        }
        showConfidenceStep(commit);
      };
    }
  } else {
    const textarea = card.querySelector('.sra-q-answer-input');
    const countEl = card.querySelector('.sra-q-answer-count-num');
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn btn-primary sra-q-submit-text';
    submitBtn.style.marginTop = '12px';
    submitBtn.textContent = 'Submit';
    submitBtn.disabled = true;
    card.appendChild(submitBtn);

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
      card.querySelector('.sra-q-confidence')?.remove();
      submitBtn.remove();

      if (level === 'adversarial') {
        // Never graded, never sent anywhere — the system acknowledges the
        // argument; it does not mark it.
        const { className, innerHTML } = respondedResultMarkup();
        appendResultNote(card, className, innerHTML);
        await store.recordAnswer(record.id, {
          questionIndex: index, chosenIndex: null, correct: null, confidence,
          gradingMethod: 'none', level, answerText, answeredAt: Date.now(),
        });
        // correct stays out of this call entirely (null, not a boolean) —
        // adversarial is never graded, and submitQuizOutcome/outcomes.js
        // only ever includes `correct` when it is a real boolean, the same
        // rule the inline path already follows.
        // Item 13j-1: adversarial has no discrete option at all — explicit
        // null, never fabricated.
        submitQuizOutcome({
          paragraphIndex: question.paragraphIndex, questionId: question.id, confidence,
          selectedAnswer: null,
        });
        appendNextButton(card, record, index);
        return;
      }

      const working = document.createElement('div');
      working.className = 'sra-q-explain';
      working.textContent = 'Checking your answer…';
      card.appendChild(working);

      // Every failure here — a thrown error, a response that failed shape
      // validation inside fetchGrading itself — degrades to 'unknown',
      // never a thrown error reaching the reader as a broken page. The
      // quiz page never keeps passage text (quiz-store.js's own header),
      // so grading here always runs on span + question alone, same as any
      // other quiz question.
      let graded = { verdict: 'unknown', span: null };
      try {
        graded = await fetchGrading({
          passage: '',
          span: question.span,
          spanRole: level === 'scenario' ? 'principle' : 'answer',
          question: question.q,
          answer: answerText,
          level,
        }) || graded;
      } catch (e) { /* graded stays 'unknown' */ }
      working.remove();

      // Second, independent guard against ever showing the reader a false
      // "wrong" at scenario — grading-client.js already refuses to produce
      // this, but this is the one place that decides what actually reaches
      // the screen here, so it does not rely solely on that having held.
      const verdict = level === 'scenario' && graded.verdict === 'incorrect' ? 'unknown' : graded.verdict;

      const { className, innerHTML } = gradedResultMarkup({ verdict, level, question, esc });
      appendResultNote(card, className, innerHTML);

      await store.recordAnswer(record.id, {
        questionIndex: index, chosenIndex: null,
        correct: verdict === 'unknown' ? null : verdict === 'correct',
        confidence, gradingMethod: 'model', level, verdict, answerText, answeredAt: Date.now(),
      });
      // An 'unknown' verdict reports no `correct` at all (undefined, not
      // false) — same reasoning as the inline path: an inconclusive grade
      // is not evidence of a wrong answer.
      // Item 13j-1: free_recall/scenario are free-text — no discrete
      // option to record, explicit null, never fabricated.
      submitQuizOutcome({
        paragraphIndex: question.paragraphIndex, questionId: question.id,
        correct: verdict === 'unknown' ? undefined : verdict === 'correct',
        confidence, selectedAnswer: null,
      });

      appendNextButton(card, record, index);
    };

    submitBtn.onclick = () => {
      if (committed || !textarea.value.trim()) return;
      // Locks the answer at the moment of submitting, before the
      // confidence step — the same moment revision stops being possible in
      // the multiple-choice flow.
      textarea.disabled = true;
      submitBtn.disabled = true;
      showConfidenceStep(commit);
    };
  }
}

/* Plain factual tally — "4 of 6 correct" — never a percentage or any
 * language implying it measures comprehension (CLAUDE.md, claims
 * discipline: no accuracy figure, anywhere). Only answers with a definite
 * correct/incorrect verdict count toward either the numerator or the
 * "wrong" styling of a row: an unknown grade or an ungraded (adversarial)
 * response is neither, and gets the same neutral row the question view
 * itself gives it, never a ✕. */
function renderResults(record) {
  $('progressRow').hidden = true;
  $('progressTrack').hidden = true;

  const byIndex = new Map(record.answers.map((a) => [a.questionIndex, a]));
  const correctCount = record.answers.filter((a) => a.correct === true).length;

  const rows = record.questions.map((q, i) => {
    const a = byIndex.get(i);
    const mark = a?.correct === true ? 'correct' : a?.correct === false ? 'wrong' : 'unknown';
    const glyph = mark === 'correct' ? '✓' : mark === 'wrong' ? '✕' : '–';
    return `
      <div class="result-row">
        <div class="result-row-top">
          <span class="result-mark ${mark}">${glyph}</span>
          <span class="result-q">${esc(q.q)}</span>
        </div>
        ${mark === 'wrong' && q.explanation ? `<div class="result-explain">${renderHighlightedExplanation(q.explanation, esc)}</div>` : ''}
        ${mark === 'wrong' && q.span ? `<div class="result-span">“${esc(q.span)}”</div>` : ''}
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

  const settings = await new Promise((resolve) =>
    chrome.storage.local.get({ sra_quiz_pending: null, sra_backend_url: '' }, resolve));
  backendUrl = settings.sra_backend_url || null;
  const pending = settings.sra_quiz_pending;

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
