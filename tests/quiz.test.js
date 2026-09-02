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

    let seenUrl = null, seenInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      seenUrl = url; seenInit = init;
      return { ok: true, json: async () => ({ recorded: true }) };
    });
    vi.stubGlobal('fetch', fetchImpl);

    await importFreshQuizJs();
    await vi.waitFor(() => expect(document.querySelector('.sra-q-option')).not.toBeNull());

    document.querySelector('.sra-q-option').click();
    await vi.waitFor(() => expect(document.querySelector('[data-conf="high"]')).not.toBeNull());
    document.querySelector('[data-conf="high"]').click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(seenUrl).toBe('https://api.alcoia.invalid/api/assignments/assign-1/outcomes');
    const body = JSON.parse(seenInit.body);
    expect(body).toEqual({
      paragraph_index: 3, question_id: 'q-server-1', correct: true, confidence: 'high', source: 'quiz',
    });
    expect(body).not.toHaveProperty('pseudonym');
    expect(seenInit.headers.Authorization).toBe('Bearer sess-tok-1');
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
