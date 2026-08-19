/* quiz-store.js — the quiz record, local-only, persisted, IndexedDB
 *
 * "Local-only, persisted, IndexedDB. Never transmitted." (the project notes, The
 * quiz — decided.) IndexedDB rather than chrome.storage.local, which
 * everything else in this extension uses: a quiz archive can grow across
 * many documents over a long time, and chrome.storage.local's quota is far
 * smaller than IndexedDB's practical one.
 *
 * "Store ONLY: the questions, the reader's answers, their confidence
 * ratings, and the verdicts." A record's `questions[].span` is a single
 * verbatim sentence — the citation the reader already sees on a wrong
 * answer (same as question-card.js) — not the passage. The paragraph text
 * used to generate the quiz is never part of a record; it exists only for
 * the length of the one generation call and is discarded.
 *
 * "This is the first feature that writes reading content to disk" —
 * questions and the reader's own answers are reading-derived content, even
 * without passage text. Deletable per document and all at once, and
 * deletion actually deletes (delete() removes the record, not a tombstone).
 *
 * Item 43 — an answer can now be free-text (`answerText`) with a
 * model-assigned `verdict`/`gradingMethod`, alongside the original
 * multiple-choice shape. This file's own promise is unchanged: what
 * recordAnswer() is given is written here, locally, and nowhere else. What
 * DOES change with this item is what happens to `answerText` a moment
 * BEFORE it reaches this function — for free_recall/scenario questions,
 * quiz.js's own commit() sends it to the grading server first (see that
 * file, and src/shared/grading-client.js) to get the verdict this store
 * then persists. That transient send is new as of this item and is not
 * this module's concern or this module's transmission — by the time
 * anything reaches recordAnswer(), grading (if any) has already happened
 * and this store, as always, only writes it to disk.
 *
 * DB access is behind a small injectable `backend` — {put, get, getAll,
 * delete}, all Promise-returning — so this module is unit-testable with a
 * plain in-memory fake instead of a real IndexedDB, which jsdom does not
 * implement. Production code gets the real backend via createIndexedDBBackend().
 */

const DB_NAME = 'alcoia_quiz';
const DB_VERSION = 1;
const STORE = 'quizzes';
const DOCUMENT_KEY_INDEX = 'documentKey';

/* Wraps a real IndexedDB implementation (window.indexedDB) in the same
 * {put, get, getAll, delete} shape createQuizStore() expects. Never called
 * from tests — see the header. */
export function createIndexedDBBackend(idb) {
  let dbPromise = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex(DOCUMENT_KEY_INDEX, DOCUMENT_KEY_INDEX, { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function getDb() {
    if (!dbPromise) dbPromise = openDb();
    return dbPromise;
  }

  async function put(record) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function get(id) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll() {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function del(id) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { put, get, getAll, delete: del };
}

function randomId(now) {
  return `q_${now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createQuizStore(opts = {}) {
  const now = opts.now || (() => Date.now());
  const backend = opts.backend
    || (opts.indexedDB && createIndexedDBBackend(opts.indexedDB))
    || (typeof indexedDB !== 'undefined' ? createIndexedDBBackend(indexedDB) : null);

  /* `record` is { documentKey, questions[] } — no passage text, no id. An id
   * and createdAt are assigned here, once, so a caller cannot accidentally
   * overwrite an existing record by reusing its id. */
  async function save(record) {
    if (!backend) throw new Error('no IndexedDB backend available');
    const withMeta = {
      documentKey: record.documentKey,
      questions: record.questions,
      answers: [],       // filled in by recordAnswer() as the reader progresses
      completedAt: null,
      id: randomId(now),
      createdAt: now(),
    };
    await backend.put(withMeta);
    return withMeta;
  }

  async function get(id) {
    if (!backend) return null;
    return backend.get(id);
  }

  /* Appends/replaces the answer for one question index and persists the
   * whole record back. Small records (5-8 questions), so rewriting the
   * whole thing on each answer is simpler than a partial update and costs
   * nothing measurable. */
  async function recordAnswer(id, answer) {
    if (!backend) return null;
    const record = await backend.get(id);
    if (!record) return null;
    const answers = record.answers.filter((a) => a.questionIndex !== answer.questionIndex);
    answers.push(answer);
    const updated = { ...record, answers };
    await backend.put(updated);
    return updated;
  }

  async function complete(id) {
    if (!backend) return null;
    const record = await backend.get(id);
    if (!record) return null;
    const updated = { ...record, completedAt: now() };
    await backend.put(updated);
    return updated;
  }

  async function listForDocument(documentKey) {
    if (!backend) return [];
    const all = await backend.getAll();
    return all
      .filter((r) => r.documentKey === documentKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async function deleteOne(id) {
    if (!backend) return;
    await backend.delete(id);
  }

  /* Deletable per document and all at once — the project notes. Both actually
   * delete the records, not mark them; nothing here soft-deletes. */
  async function deleteForDocument(documentKey) {
    if (!backend) return 0;
    const records = await listForDocument(documentKey);
    for (const r of records) await backend.delete(r.id);
    return records.length;
  }

  async function deleteAll() {
    if (!backend) return 0;
    const all = await backend.getAll();
    for (const r of all) await backend.delete(r.id);
    return all.length;
  }

  return { save, get, recordAnswer, complete, listForDocument, deleteOne, deleteForDocument, deleteAll };
}
