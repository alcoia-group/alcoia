import { describe, it, expect } from 'vitest';
import { createQuizStore } from '../alcoia/src/content/quiz-store.js';

/* jsdom does not implement IndexedDB, so quiz-store.js takes an injectable
 * {put, get, getAll, delete} backend — this is a plain in-memory stand-in
 * for it, not a real IndexedDB. createIndexedDBBackend() (the real wrapper)
 * is exercised only by the browser smoke check, which has a real browser. */
function fakeBackend() {
  const map = new Map();
  return {
    put: async (record) => { map.set(record.id, record); },
    get: async (id) => map.get(id) || null,
    getAll: async () => [...map.values()],
    delete: async (id) => { map.delete(id); },
  };
}

function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const QUESTIONS = [
  { q: 'Q1', options: ['a', 'b', 'c', 'd'], answerIndex: 0, explanation: 'e1', span: 'span one' },
  { q: 'Q2', options: ['a', 'b', 'c', 'd'], answerIndex: 1, explanation: 'e2', span: 'span two' },
];

describe('save', () => {
  it('assigns an id and createdAt, and stores no passage text', async () => {
    const clock = fixedClock();
    const store = createQuizStore({ backend: fakeBackend(), now: clock.now });
    const record = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });

    expect(record.id).toMatch(/^q_/);
    expect(record.createdAt).toBe(1_000_000);
    expect(record.documentKey).toBe('a.com/p');
    expect(record.questions).toEqual(QUESTIONS);
    expect(record.answers).toEqual([]);
    expect(record.completedAt).toBeNull();
    // Nothing anywhere on the record beyond the question objects themselves
    // (which only ever carry a short verbatim `span` citation, never a
    // whole paragraph) has a place for bulk passage text to live.
    expect(Object.keys(record).sort()).toEqual(
      ['answers', 'completedAt', 'createdAt', 'documentKey', 'id', 'questions'].sort());
  });

  it('assigns distinct ids to separate quizzes', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    const a = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    const b = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    expect(a.id).not.toBe(b.id);
  });
});

describe('get', () => {
  it('returns the saved record by id', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    const saved = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    const fetched = await store.get(saved.id);
    expect(fetched).toEqual(saved);
  });

  it('returns null for an unknown id', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    expect(await store.get('nope')).toBeNull();
  });
});

describe('recordAnswer', () => {
  it('appends an answer for a question index', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    const saved = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    const updated = await store.recordAnswer(saved.id, {
      questionIndex: 0, chosenIndex: 0, correct: true, confidence: 'high', answeredAt: 1,
    });
    expect(updated.answers).toHaveLength(1);
    expect(updated.answers[0].correct).toBe(true);
  });

  it('replaces rather than duplicates an answer for the same question index', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    const saved = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    await store.recordAnswer(saved.id, { questionIndex: 0, chosenIndex: 1, correct: false, confidence: null, answeredAt: 1 });
    const updated = await store.recordAnswer(saved.id, { questionIndex: 0, chosenIndex: 0, correct: true, confidence: 'low', answeredAt: 2 });
    expect(updated.answers).toHaveLength(1);
    expect(updated.answers[0].correct).toBe(true);
  });

  it('accumulates answers across different question indices', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    const saved = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    await store.recordAnswer(saved.id, { questionIndex: 0, chosenIndex: 0, correct: true, confidence: null, answeredAt: 1 });
    const updated = await store.recordAnswer(saved.id, { questionIndex: 1, chosenIndex: 1, correct: true, confidence: null, answeredAt: 2 });
    expect(updated.answers).toHaveLength(2);
  });

  it('returns null for an unknown id rather than throwing', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    expect(await store.recordAnswer('nope', { questionIndex: 0 })).toBeNull();
  });
});

describe('complete', () => {
  it('sets completedAt', async () => {
    const clock = fixedClock();
    const store = createQuizStore({ backend: fakeBackend(), now: clock.now });
    const saved = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    clock.advance(5000);
    const updated = await store.complete(saved.id);
    expect(updated.completedAt).toBe(1_005_000);
  });
});

describe('listForDocument', () => {
  it('returns only records for the given document, newest first', async () => {
    const clock = fixedClock();
    const store = createQuizStore({ backend: fakeBackend(), now: clock.now });
    await store.save({ documentKey: 'a.com/one', questions: QUESTIONS });
    clock.advance(1000);
    const second = await store.save({ documentKey: 'a.com/one', questions: QUESTIONS });
    await store.save({ documentKey: 'a.com/two', questions: QUESTIONS });

    const list = await store.listForDocument('a.com/one');
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(second.id); // newest first
  });

  it('returns an empty array for a document with no quizzes', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    expect(await store.listForDocument('nowhere')).toEqual([]);
  });
});

describe('deletion — must actually delete, not tombstone', () => {
  it('deleteOne removes exactly that record', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    const a = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    const b = await store.save({ documentKey: 'a.com/p', questions: QUESTIONS });
    await store.deleteOne(a.id);
    expect(await store.get(a.id)).toBeNull();
    expect(await store.get(b.id)).not.toBeNull();
  });

  it('deleteForDocument removes every record for that document only', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    await store.save({ documentKey: 'a.com/one', questions: QUESTIONS });
    await store.save({ documentKey: 'a.com/one', questions: QUESTIONS });
    await store.save({ documentKey: 'a.com/two', questions: QUESTIONS });

    const deletedCount = await store.deleteForDocument('a.com/one');
    expect(deletedCount).toBe(2);
    expect(await store.listForDocument('a.com/one')).toEqual([]);
    expect(await store.listForDocument('a.com/two')).toHaveLength(1);
  });

  it('deleteAll empties the store entirely', async () => {
    const store = createQuizStore({ backend: fakeBackend() });
    await store.save({ documentKey: 'a.com/one', questions: QUESTIONS });
    await store.save({ documentKey: 'a.com/two', questions: QUESTIONS });
    const deletedCount = await store.deleteAll();
    expect(deletedCount).toBe(2);
    expect(await store.listForDocument('a.com/one')).toEqual([]);
    expect(await store.listForDocument('a.com/two')).toEqual([]);
  });
});

describe('no backend available', () => {
  it('degrades to empty/null results rather than throwing on reads', async () => {
    const store = createQuizStore({ backend: null });
    expect(await store.get('x')).toBeNull();
    expect(await store.listForDocument('x')).toEqual([]);
    expect(await store.recordAnswer('x', {})).toBeNull();
    expect(await store.complete('x')).toBeNull();
    expect(await store.deleteForDocument('x')).toBe(0);
    expect(await store.deleteAll()).toBe(0);
    await expect(store.deleteOne('x')).resolves.toBeUndefined();
  });

  it('throws on save — silently discarding a generated quiz would be worse', async () => {
    const store = createQuizStore({ backend: null });
    await expect(store.save({ documentKey: 'x', questions: QUESTIONS })).rejects.toThrow();
  });
});
