import { describe, it, expect } from 'vitest';
import Q from '../TL_DR/server/questions.js';

const {
  contentHash, buildQuestionPrompt, extractJsonArray,
  parseQuestions, createQuestionCache, clampCount,
} = Q;

const PASSAGE = `The measurement of reading comprehension has a long history. A reader may fixate
steadily on a paragraph while thinking about something else entirely. The relationship between
where the eyes point and what the mind does is real but weak.`;

const good = (over = {}) => ({
  q: 'What is the relationship between eye position and thought described as?',
  options: ['Real but weak', 'Strong and direct', 'Nonexistent', 'Perfectly correlated'],
  answerIndex: 0,
  explanation: 'The passage calls the relationship real but weak.',
  span: 'The relationship between where the eyes point and what the mind does is real but weak.',
  ...over,
});

describe('contentHash', () => {
  it('is stable and ignores whitespace differences', () => {
    expect(contentHash('a b  c')).toBe(contentHash('a  b c'));
    expect(contentHash('a b c')).toBe(contentHash('a b c'));
  });

  it('separates different passages and different options', () => {
    expect(contentHash('one')).not.toBe(contentHash('two'));
    expect(contentHash('one', { kind: 'recall' })).not.toBe(contentHash('one', { kind: 'inference' }));
    expect(contentHash('one', { count: 2 })).not.toBe(contentHash('one', { count: 3 }));
  });
});

describe('buildQuestionPrompt', () => {
  it('demands a verbatim span and JSON only', () => {
    const p = buildQuestionPrompt(PASSAGE);
    expect(p).toMatch(/VERBATIM/);
    expect(p).toMatch(/ONLY a JSON array/);
    expect(p).toContain('real but weak');
  });

  it('asks for the requested number and kind', () => {
    expect(buildQuestionPrompt(PASSAGE, { count: 1 })).toMatch(/Write 1 multiple-choice question\b/);
    expect(buildQuestionPrompt(PASSAGE, { count: 3 })).toMatch(/Write 3 multiple-choice questions/);
    expect(buildQuestionPrompt(PASSAGE, { kind: 'inference' })).toMatch(/connect two ideas/);
  });

  it('clamps absurd counts', () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(99)).toBe(5);
    expect(clampCount(undefined)).toBe(2);
  });
});

describe('extractJsonArray', () => {
  it('reads a bare array', () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('reads through a markdown fence', () => {
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('reads through surrounding prose', () => {
    expect(extractJsonArray('Sure! Here you go:\n[{"a":1}]\nHope that helps.')).toEqual([{ a: 1 }]);
  });

  it('returns null rather than throwing on rubbish', () => {
    for (const bad of ['', 'no json here', '{"not":"an array"}', '[unclosed', null, undefined, 42]) {
      expect(extractJsonArray(bad)).toBeNull();
    }
  });
});

/* The point of the module. Each rejection here is a question that would
 * otherwise have been asked of a reader who is already struggling. */
describe('parseQuestions rejects what it cannot trust', () => {
  const parse = (q) => parseQuestions(JSON.stringify([q]), PASSAGE);

  it('accepts a well-formed question', () => {
    const out = parse(good());
    expect(out).toHaveLength(1);
    expect(out[0].answerIndex).toBe(0);
    expect(out[0].span).toContain('real but weak');
  });

  it('rejects a span that is not in the passage — the model invented its evidence', () => {
    expect(parse(good({ span: 'Eye tracking is accurate to within a single character.' }))).toHaveLength(0);
  });

  it('rejects a paraphrased span', () => {
    expect(parse(good({ span: 'The link between gaze and thought is weak but real.' }))).toHaveLength(0);
  });

  it('tolerates a span that differs only in line wrapping', () => {
    const wrapped = 'The relationship between where the eyes point\nand what the mind does is real but weak.';
    expect(parse(good({ span: wrapped }))).toHaveLength(1);
  });

  it.each([
    ['three options', { options: ['a', 'b', 'c'] }],
    ['five options', { options: ['a', 'b', 'c', 'd', 'e'] }],
    ['an empty option', { options: ['Real but weak', '', 'c', 'd'] }],
    ['duplicate options', { options: ['Real but weak', 'Real but weak', 'c', 'd'] }],
    ['an out-of-range answer', { answerIndex: 4 }],
    ['a negative answer', { answerIndex: -1 }],
    ['a non-integer answer', { answerIndex: 1.5 }],
    ['a missing answer', { answerIndex: undefined }],
    ['a stub question', { q: 'Why?' }],
    ['a stub span', { span: 'history.' }],
  ])('rejects %s', (_label, over) => {
    expect(parse(good(over))).toHaveLength(0);
  });

  it('drops the bad ones and keeps the good ones', () => {
    const raw = JSON.stringify([good({ span: 'invented sentence not present' }), good()]);
    expect(parseQuestions(raw, PASSAGE)).toHaveLength(1);
  });

  it('drops a repeated question', () => {
    const raw = JSON.stringify([good(), good()]);
    expect(parseQuestions(raw, PASSAGE)).toHaveLength(1);
  });

  it('never returns more than asked for', () => {
    const many = [good(), good({ q: 'What may a reader do while thinking of something else?' }),
      good({ q: 'What has a long history according to this?' })];
    // All cite valid spans, but only two were requested.
    const raw = JSON.stringify(many.map((m) => ({ ...m, span: good().span })));
    expect(parseQuestions(raw, PASSAGE, { count: 2 }).length).toBeLessThanOrEqual(2);
  });

  it('returns nothing for an unparseable response', () => {
    expect(parseQuestions('the model apologised instead', PASSAGE)).toEqual([]);
  });
});

describe('question cache', () => {
  function clock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  it('returns what was stored', () => {
    const c = createQuestionCache({ now: clock().now });
    c.set('k', [good()]);
    expect(c.get('k')).toHaveLength(1);
  });

  it('misses on an unknown key', () => {
    expect(createQuestionCache().get('nope')).toBeNull();
  });

  it('expires entries', () => {
    const t = clock();
    const c = createQuestionCache({ now: t.now, ttlMs: 1000 });
    c.set('k', [good()]);
    t.advance(1001);
    expect(c.get('k')).toBeNull();
  });

  it('evicts least-recently-used past the cap', () => {
    const c = createQuestionCache({ maxEntries: 3 });
    c.set('a', [1]); c.set('b', [2]); c.set('c', [3]);
    c.get('a');              // 'a' is now the most recent
    c.set('d', [4]);         // evicts 'b'
    expect(c.size()).toBe(3);
    expect(c.get('a')).toEqual([1]);
    expect(c.get('b')).toBeNull();
    expect(c.get('d')).toEqual([4]);
  });
});
