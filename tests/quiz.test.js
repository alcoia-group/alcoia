// @vitest-environment jsdom
/* quiz.js's outcome-reporting side channel (item 13i): when a quiz is
 * taken on an assignment's document, each answered question also reports
 * an outcome, source: 'quiz', via the exact same pseudonym-deriving
 * submission path inline outcomes use (outcomes.js, item 9b/S6-E4) —
 * reused, not duplicated. On ordinary (non-assignment) reading, nothing
 * changes: no assignmentId in the URL, so submitQuizOutcome stays the
 * no-op default and no outcomes-reporting capability is constructed at
 * all — not merely unused.
 *
 * quiz.js is a plain top-level script (boot() runs as an import side
 * effect, reading location.href and real DOM elements immediately), same
 * shape as popup.js — follows tests/popup-account.test.js's own
 * established pattern: load the REAL quiz.html body into jsdom, set
 * location before importing, import the module fresh (a cache-busting
 * query param) per test so each test gets its own boot().
 *
 * quiz-store.js's own header notes jsdom does not implement IndexedDB,
 * and this project deliberately never built a fake for it (quiz-
 * store.test.js always injects opts.backend directly instead). Driving a
 * real boot() through to a rendered, clickable question needs quiz-
 * store.js's real createQuizStore(), called internally by quiz.js with no
 * injection point — so a minimal, self-contained fake indexedDB global
 * lives in this file, scoped to exactly the put/get/getAll/delete shape
 * createIndexedDBBackend() actually uses. It does not attempt to be a
 * general IndexedDB polyfill.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createQuizStore } from '../alcoia/src/content/quiz-store.js';
import { fileURLToPath } from 'node:url';

const QUIZ_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'alcoia', 'src', 'popup', 'quiz.html',
);

function loadQuizBody() {
  const html = fs.readFileSync(QUIZ_HTML_PATH, 'utf8');
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  if (!match) throw new Error('quiz.html body not found — did its structure change?');
  document.body.innerHTML = match[1].replace(/<script[\s\S]*?<\/script>/g, '');
}

/* Minimal fake backing createIndexedDBBackend() in quiz-store.js — one
 * named database, one object store with a keyPath, one index it never
 * actually queries by in this file's tests (getAll()+filter is all
 * quiz-store.js's own listForDocument() does). Every callback fires via a
 * queued microtask, deferred exactly like real IndexedDB, so handler
 * assignment made synchronously right after the call (openDb()'s own
 * pattern) is always attached before it fires. */
function installFakeIndexedDB() {
  const databases = new Map(); // name -> { stores: Map(storeName -> { keyPath, data: Map }) }

  function request() {
    const req = {};
    return { req, resolve: (result) => queueMicrotask(() => { req.result = result; req.onsuccess?.({ target: req }); }) };
  }

  vi.stubGlobal('indexedDB', {
    open(name) {
      const { req, resolve } = request();
      queueMicrotask(() => {
        if (!databases.has(name)) databases.set(name, { stores: new Map() });
        const dbRecord = databases.get(name);
        const db = {
          objectStoreNames: { contains: (n) => dbRecord.stores.has(n) },
          createObjectStore(storeName, opts) {
            dbRecord.stores.set(storeName, { keyPath: opts.keyPath, data: new Map() });
            return { createIndex() {} };
          },
          transaction(storeName) {
            const store = dbRecord.stores.get(storeName);
            const tx = {};
            queueMicrotask(() => tx.oncomplete?.());
            return {
              objectStore: () => ({
                put(record) { store.data.set(record[store.keyPath], record); },
                delete(key) { store.data.delete(key); },
                get(key) {
                  const { req: getReq, resolve: getResolve } = request();
                  getResolve(store.data.get(key));
                  return getReq;
                },
                getAll() {
                  const { req: getAllReq, resolve: getAllResolve } = request();
                  getAllResolve([...store.data.values()]);
                  return getAllReq;
                },
              }),
              set oncomplete(fn) { tx.oncomplete = fn; },
              onerror: null,
            };
          },
        };
        // Real IndexedDB sets request.result before firing onupgradeneeded
        // (the request IS event.target) — quiz-store.js's own openDb()
        // reads req.result via closure, not the event argument, so this
        // has to be a real property on req itself, not a mock event object.
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        resolve(db);
      });
      return req;
    },
  });
}

const RECOGNITION_QUESTION = {
  id: 'q-server-1',
  q: 'What is the relationship described as?',
  options: ['Real but weak', 'Strong', 'Nonexistent', 'Perfect'],
  answerIndex: 0,
  explanation: 'The passage says so.',
  span: 'The relationship is real but weak.',
  paragraphIndex: 3,
};

function fakeChrome(seed = {}) {
  const store = { ...seed };
  return {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          for (const [k, def] of Object.entries(keys || {})) result[k] = k in store ? store[k] : def;
          cb(result);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
        remove(key, cb) { delete store[key]; if (cb) cb(); },
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { getURL: (p) => 'chrome-extension://test/' + p },
    _store: store,
  };
}

function setLocation(search) {
  window.history.pushState({}, '', '/src/popup/quiz.html' + search);
}

async function importFreshQuizJs() {
  const url = '../alcoia/src/popup/quiz.js?t=' + Date.now() + Math.random();
  await import(/* @vite-ignore */ url);
}

describe('quiz.js outcome reporting (item 13i)', () => {
  it('a quiz taken on an assignment document POSTs a real outcome tagged source: "quiz", with no client-supplied pseudonym', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc1&assignmentId=assign-1');
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc1', questions: [RECOGNITION_QUESTION], createdAt: Date.now() },
      sra_session: { token: 'sess-tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    // Step 5: renderQuestion() now also fires a real "intervention presented"
    // POST (to .../interventions) the moment the question renders, before any
    // answer — genuinely independent of the outcomes POST this test is about.
    // Captures every call rather than the single most-recent one, and picks
    // out the .../outcomes call specifically, so this test stays correct
    // regardless of the real timing between the two.
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ recorded: true }) };
    });
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());

    document.querySelector('.sra-q-option').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/outcomes'))).toBe(true));
    const outcomeCall = calls.find((c) => c.url.endsWith('/outcomes'));
    expect(outcomeCall.url).toBe('https://api.alcoia.invalid/api/assignments/assign-1/outcomes');
    const body = JSON.parse(outcomeCall.init.body);
    // intervention_id (step 5) is a real, non-empty string — checked for
    // shape here, and cross-checked against the intervention report below,
    // rather than duplicating the dedicated interventionId test's own
    // exact-value assertions.
    expect(typeof body.intervention_id).toBe('string');
    expect(body.intervention_id.length).toBeGreaterThan(0);
    const outcomeInterventionId = body.intervention_id;
    delete body.intervention_id;
    expect(body).toEqual({
      paragraph_index: 3, question_id: 'q-server-1', correct: true, confidence: 'high', source: 'quiz',
      // Item 13j-1: the real chosen option (index 0, the one clicked above).
      selected_answer: 0,
    });
    expect(body).not.toHaveProperty('pseudonym');
    expect(outcomeCall.init.headers.Authorization).toBe('Bearer sess-tok-1');

    // The intervention itself was also genuinely reported, same assignment,
    // same endpoint family, real fields — step 5's other half of this flow.
    // Same id as the outcome above carried, proving genuine linkage rather
    // than two independently-generated, unrelated values.
    const interventionCall = calls.find((c) => c.url.endsWith('/interventions'));
    expect(interventionCall).toBeDefined();
    expect(interventionCall.url).toBe('https://api.alcoia.invalid/api/assignments/assign-1/interventions');
    const interventionBody = JSON.parse(interventionCall.init.body);
    expect(interventionBody.type).toBe('quiz');
    expect(interventionBody.paragraph_index).toBe(3);
    expect(interventionBody.intervention_id).toBe(outcomeInterventionId);
  });

  it('a wrong quiz answer under assignment context sends the real WRONG option as selected_answer', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc4&assignmentId=assign-1');
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc4', questions: [RECOGNITION_QUESTION], createdAt: Date.now() },
      sra_session: { token: 'sess-tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    // Step 5: see the previous test's own comment — two real, independent
    // POSTs now happen (.../interventions at render, .../outcomes at
    // answer); pick the outcomes one out specifically.
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ recorded: true }) }; });
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option[data-index="1"]')).not.toBeNull());

    document.querySelector('.sra-q-option[data-index="1"]').click(); // wrong — answerIndex is 0
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/outcomes'))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.endsWith('/outcomes')).init.body);
    expect(body.correct).toBe(false);
    expect(body.selected_answer).toBe(1);
  });

  it('a free-text-level quiz question (adversarial) sends selected_answer: null explicitly', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc5&assignmentId=assign-1');
    const adversarialQuestion = {
      id: 'q-server-adv', q: 'Argue against this claim.', level: 'adversarial',
      span: 'The relationship is real but weak.', paragraphIndex: 6,
    };
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc5', questions: [adversarialQuestion], createdAt: Date.now() },
      sra_session: { token: 'sess-tok-1', email: 'reader@example.com', expiresAt: Date.now() + 999_999 },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    // Step 5: see the first test's own comment.
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ recorded: true }) }; });
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-answer-input')).not.toBeNull());

    const textarea = document.querySelector('.sra-q-answer-input');
    textarea.value = 'a counter-argument';
    textarea.dispatchEvent(new Event('input'));
    document.querySelector('.sra-q-submit-text').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/outcomes'))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.endsWith('/outcomes')).init.body);
    expect(body.paragraph_index).toBe(6);
    expect(body).not.toHaveProperty('correct'); // adversarial is never graded
    expect(body).toHaveProperty('selected_answer', null);
  });

  it('a quiz taken on ordinary (non-assignment) reading produces ZERO network calls — explicit regression', async () => {
    // No fake IndexedDB installed here on purpose — boot() itself never
    // needs to succeed for this assertion. Whether or not this quiz's own
    // storage/render machinery works is irrelevant to the one thing being
    // proven: with no assignmentId in the URL, the outcomes-reporting
    // capability is never even constructed, so nothing it could do is
    // reachable at all, regardless of what else happens on the page.
    loadQuizBody();
    setLocation('?key=doc2');
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc2', questions: [RECOGNITION_QUESTION], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshQuizJs();
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a quiz taken on ordinary reading still produces zero network calls even when fully played through, with real IndexedDB working', async () => {
    // The stronger version of the regression above: this time boot()
    // genuinely succeeds and the reader answers a real question end to
    // end — confirming silence is not just an artifact of boot() failing
    // for an unrelated reason.
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc3');
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc3', questions: [RECOGNITION_QUESTION], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());

    document.querySelector('.sra-q-option').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* Evidence-silo fix (intelligence-architecture audit, step 2): every
 * answered quiz question now ALSO produces a response-signals.js-shaped
 * record in chrome.storage.local's sra_quiz_evidence, tagged source:'quiz'
 * and documentKey — read back by host.js's pickLevel() in the tab that
 * generated the quiz, since this page runs in a separate tab with no
 * shared JS realm to write into directly. This is local-only and
 * unconditional (runs for ordinary, non-assignment quizzes too, unlike
 * submitQuizOutcome above) — deliberately kept as its own describe block
 * so it's clear this has nothing to do with the assignment/server path
 * item 13i already covers. */
describe('quiz.js local evidence-history recording (intelligence-architecture audit, step 2)', () => {
  const WITH_KEY_QUESTION = {
    ...RECOGNITION_QUESTION,
    id: 'q-server-2',
    paragraphKey: 'a real paragraph key computed by host.js at quiz-generation time',
  };

  it('a correct recognition answer writes a matching sra_quiz_evidence record — source:quiz, correct:true, real paragraphKey/paragraphIndex/questionId', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc-ev-1');
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc-ev-1', questions: [WITH_KEY_QUESTION], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());
    document.querySelector('.sra-q-option').click(); // correct — answerIndex is 0
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(chrome._store.sra_quiz_evidence).toBeDefined());
    const [record] = chrome._store.sra_quiz_evidence;
    expect(record).toMatchObject({
      documentKey: 'doc-ev-1',
      type: 'response',
      subtype: 'correct',
      correct: true,
      confidence: 'high',
      gradingMethod: 'deterministic',
      level: 'recognition',
      source: 'quiz',
      paragraphKey: WITH_KEY_QUESTION.paragraphKey,
      paragraphIndex: 3,
      questionId: 'q-server-2',
    });
  });

  it('an incorrect recognition answer writes correct:false, and a question with no paragraphKey writes paragraphKey:null rather than a guess', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc-ev-2');
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc-ev-2', questions: [RECOGNITION_QUESTION], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option[data-index="1"]')).not.toBeNull());
    document.querySelector('.sra-q-option[data-index="1"]').click(); // wrong
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(chrome._store.sra_quiz_evidence).toBeDefined());
    const [record] = chrome._store.sra_quiz_evidence;
    expect(record.correct).toBe(false);
    expect(record.paragraphKey).toBeNull(); // RECOGNITION_QUESTION carries no paragraphKey
  });

  it('an adversarial answer writes correct:null — never graded, same as the inline card', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc-ev-3');
    const adversarialQuestion = {
      id: 'q-server-adv-ev', q: 'Argue against this claim.', level: 'adversarial',
      span: 'The relationship is real but weak.', paragraphIndex: 6,
    };
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc-ev-3', questions: [adversarialQuestion], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-answer-input')).not.toBeNull());
    const textarea = document.querySelector('.sra-q-answer-input');
    textarea.value = 'a counter-argument';
    textarea.dispatchEvent(new Event('input'));
    document.querySelector('.sra-q-submit-text').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(chrome._store.sra_quiz_evidence).toBeDefined());
    const [record] = chrome._store.sra_quiz_evidence;
    expect(record.correct).toBeNull();
    expect(record.gradingMethod).toBe('none');
    expect(record.level).toBe('adversarial');
    expect(record.source).toBe('quiz');
  });

  it('a free_recall/scenario answer writes the model verdict, downgraded the same safe way the on-screen result already is', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc-ev-4');
    const scenarioQuestion = {
      id: 'q-server-scenario', q: 'Apply this to a new case.', level: 'scenario',
      span: 'The relationship is real but weak.', paragraphIndex: 2,
    };
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc-ev-4', questions: [scenarioQuestion], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });
    // grading-client.js's fetchGrading calls the token endpoint then the
    // grade endpoint — both real fetch() calls this page makes itself.
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/api/token')) return { ok: true, json: async () => ({ token: 'inst-1' }) };
      // A server-graded 'incorrect' verdict at scenario must be shown (and
      // now recorded) as 'unknown' — grading-client.js's own safety net,
      // confirmed still honoured by this new write, not bypassed by it.
      return { ok: true, json: async () => ({ verdict: 'incorrect', span: 'The relationship is real but weak.' }) };
    }));

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-answer-input')).not.toBeNull());
    const textarea = document.querySelector('.sra-q-answer-input');
    textarea.value = 'my applied answer';
    textarea.dispatchEvent(new Event('input'));
    document.querySelector('.sra-q-submit-text').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(chrome._store.sra_quiz_evidence).toBeDefined());
    const [record] = chrome._store.sra_quiz_evidence;
    expect(record.subtype).toBe('unknown'); // never 'incorrect' at scenario
    expect(record.correct).toBeNull();
    expect(record.gradingMethod).toBe('model');
  });

  it('multiple answered questions in one quiz session accumulate as separate entries, in order', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc-ev-5');
    const q1 = { ...RECOGNITION_QUESTION, id: 'q-1' };
    const q2 = { ...RECOGNITION_QUESTION, id: 'q-2' };
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc-ev-5', questions: [q1, q2], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());
    document.querySelector('.sra-q-option').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();
    await vi.waitFor(() => expect(chrome._store.sra_quiz_evidence).toHaveLength(1));

    document.querySelector('.btn-primary').click(); // "Next question"
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());
    document.querySelector('.sra-q-option').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(chrome._store.sra_quiz_evidence).toHaveLength(2));
    expect(chrome._store.sra_quiz_evidence.map((r) => r.questionId)).toEqual(['q-1', 'q-2']);
  });

  it('none of this touches the network — evidence recording is chrome.storage.local only, on ordinary (non-assignment) reading', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc-ev-6'); // no assignmentId
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc-ev-6', questions: [RECOGNITION_QUESTION], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());
    document.querySelector('.sra-q-option').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(chrome._store.sra_quiz_evidence).toBeDefined());
    expect(fetchImpl).not.toHaveBeenCalled(); // no server call fired by recording local evidence
  });

  it('quiz-store IndexedDB persistence is unaffected — recordAnswer still writes the full answer record exactly as before', async () => {
    installFakeIndexedDB();
    loadQuizBody();
    setLocation('?key=doc-ev-7');
    vi.stubGlobal('chrome', fakeChrome({
      sra_quiz_pending: { key: 'doc-ev-7', questions: [RECOGNITION_QUESTION], createdAt: Date.now() },
    }));
    vi.stubGlobal('ALCOIA_CONFIG', {
      SUMMARIZE_URL: 'https://api.alcoia.invalid/api/summarize',
      TOKEN_URL: 'https://api.alcoia.invalid/api/token',
      ASSIGNMENTS_URL: 'https://api.alcoia.invalid/api/assignments',
    });

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());
    document.querySelector('.sra-q-option').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    // The real quiz-store.js record, read back through the real
    // (fake-backed) IndexedDB — untouched by this item's own new write.
    const store = createQuizStore();
    await vi.waitFor(async () => {
      const records = await store.listForDocument('doc-ev-7');
      expect(records).toHaveLength(1);
      expect(records[0].answers).toHaveLength(1);
    });
    const [record] = await store.listForDocument('doc-ev-7');
    expect(record.answers[0]).toMatchObject({
      questionIndex: 0, chosenIndex: 0, correct: true, confidence: 'high',
      gradingMethod: 'deterministic', level: 'recognition',
    });
  });
});
