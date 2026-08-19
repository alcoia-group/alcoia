import { describe, it, expect } from 'vitest';
import Q from './contract/questions.js';

const {
  contentHash, buildQuestionPrompt, extractJsonArray,
  parseQuestions, validateQuestion, createQuestionCache, clampCount,
  LEVELS, SPAN_ROLE_FOR_LEVEL,
} = Q;

const PASSAGE = `The measurement of reading comprehension has a long history. A reader may fixate
steadily on a paragraph while thinking about something else entirely. The relationship between
where the eyes point and what the mind does is real but weak.`;

// span_role: 'answer' is part of the well-formed shape as of item 42 — a
// fixture predating that item would have omitted it, which is exactly what
// the new "declared level and span_role disagree" rule now rejects.
const good = (over = {}) => ({
  q: 'What is the relationship between eye position and thought described as?',
  options: ['Real but weak', 'Strong and direct', 'Nonexistent', 'Perfectly correlated'],
  answerIndex: 0,
  explanation: 'The passage calls the relationship real but weak.',
  span: 'The relationship between where the eyes point and what the mind does is real but weak.',
  span_role: 'answer',
  ...over,
});

// item 42: scenario anchors to a PRINCIPLE the passage states, not the
// answer — the question applies that principle to a new situation the
// passage never describes, and the correct option follows from the
// application, not from anything written in the passage.
const scenarioGood = (over = {}) => ({
  q: 'A researcher watches a reader\'s gaze sit steadily on one paragraph for ten seconds. Does that alone prove the reader understood it?',
  options: [
    'No — gaze position only weakly predicts what the mind is doing',
    'Yes — steady fixation always means the reader understood',
    'Only if the reader also underlines the text',
    'Fixation duration is completely unrelated to comprehension',
  ],
  answerIndex: 0,
  explanation: 'The stated principle is that gaze position is a real but weak signal of what the mind is doing, so steady fixation alone cannot prove understanding.',
  span: 'The relationship between where the eyes point and what the mind does is real but weak.',
  span_role: 'principle',
  ...over,
});

// item 42: adversarial anchors to a CLAIM the passage makes, and challenges
// it — the correct option requires reasoning about the challenge, not a
// fact stated in the passage.
const adversarialGood = (over = {}) => ({
  q: 'If eye-tracking hardware became perfectly accurate, would that alone guarantee accurate comprehension measurement?',
  options: [
    'No — a reader can fixate steadily while thinking about something else entirely',
    'Yes — perfect fixation tracking guarantees comprehension tracking',
    'Only for passages longer than one paragraph',
    'Fixation and comprehension were never claimed to be related at all',
  ],
  answerIndex: 0,
  explanation: 'The passage claims a reader can fixate steadily while thinking about something else, so perfecting the fixation measurement would not close that gap.',
  span: 'A reader may fixate steadily on a paragraph while thinking about something else entirely.',
  span_role: 'claim',
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

  // item 42: a scenario question and a recognition question on the same
  // passage are not interchangeable — they must not collide in the cache.
  it('separates different levels, and treats a missing level as recognition', () => {
    expect(contentHash('one', { level: 'recognition' })).not.toBe(contentHash('one', { level: 'scenario' }));
    expect(contentHash('one', { level: 'scenario' })).not.toBe(contentHash('one', { level: 'adversarial' }));
    expect(contentHash('one')).toBe(contentHash('one', { level: 'recognition' }));
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

  // item 42: one level per call. The caller decides which of the four to
  // ask for; the model is never shown the other levels' framing to pick
  // from, and never asked to state its own level.
  describe('one level per call (item 42)', () => {
    it('defaults to the original recognition/free_recall shape when no level is given', () => {
      const p = buildQuestionPrompt(PASSAGE);
      expect(p).toMatch(/"span_role" must be exactly "answer"/);
      expect(p).toMatch(/single sentence containing the answer/);
    });

    it('asks for a scenario question anchored to a principle, not an answer', () => {
      const p = buildQuestionPrompt(PASSAGE, { level: 'scenario' });
      expect(p).toMatch(/APPLY a principle/);
      expect(p).toMatch(/single sentence stating the PRINCIPLE/);
      expect(p).toMatch(/"span_role" must be exactly "principle"/);
      expect(p).not.toMatch(/"span_role" must be exactly "answer"/);
      expect(p).not.toMatch(/"span_role" must be exactly "claim"/);
    });

    it('asks for an adversarial question anchored to a claim', () => {
      const p = buildQuestionPrompt(PASSAGE, { level: 'adversarial' });
      expect(p).toMatch(/CHALLENGE a claim/);
      expect(p).toMatch(/single sentence stating the CLAIM/);
      expect(p).toMatch(/"span_role" must be exactly "claim"/);
      expect(p).not.toMatch(/"span_role" must be exactly "answer"/);
      expect(p).not.toMatch(/"span_role" must be exactly "principle"/);
    });

    it('still demands a verbatim span at every level', () => {
      for (const level of LEVELS) {
        expect(buildQuestionPrompt(PASSAGE, { level })).toMatch(/VERBATIM/);
      }
    });

    it('an unrecognised level falls back to the recognition/free_recall shape rather than inventing a fifth', () => {
      const p = buildQuestionPrompt(PASSAGE, { level: 'omniscient' });
      expect(p).toMatch(/"span_role" must be exactly "answer"/);
    });
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

/* Item 42: the span stays mandatory, verbatim, and present in the passage at
 * every level — this block exists to prove that rule did not bend anywhere
 * while adding scenario and adversarial, whose ANSWERS are legitimately
 * outside the passage. What changed is only what the span is required to
 * anchor to (SPAN_ROLE_FOR_LEVEL), never whether one is required. */
describe('level-dependent span validation (item 42)', () => {
  const parseAt = (q, level) => parseQuestions(JSON.stringify([q]), PASSAGE, { level });

  it('accepts a well-formed recognition question — unchanged from before item 42', () => {
    const out = parseAt(good(), 'recognition');
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('recognition');
    expect(out[0].span_role).toBe('answer');
    expect(out[0].span).toContain('real but weak');
  });

  it('accepts a well-formed free_recall question under the same span rule as recognition', () => {
    const out = parseAt(good(), 'free_recall');
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('free_recall');
    expect(out[0].span_role).toBe('answer');
  });

  it('accepts a well-formed scenario question whose span anchors to a principle genuinely in the passage', () => {
    const out = parseAt(scenarioGood(), 'scenario');
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('scenario');
    expect(out[0].span_role).toBe('principle');
  });

  it('rejects a scenario question whose span is absent from the passage', () => {
    const out = parseAt(scenarioGood({ span: 'Eye trackers have become far cheaper in the last decade.' }), 'scenario');
    expect(out).toHaveLength(0);
  });

  it('accepts an adversarial question citing a claim genuinely in the passage', () => {
    const out = parseAt(adversarialGood(), 'adversarial');
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('adversarial');
    expect(out[0].span_role).toBe('claim');
  });

  it('rejects an adversarial question whose span is absent from the passage', () => {
    const out = parseAt(adversarialGood({ span: 'Nothing resembling this sentence appears anywhere above.' }), 'adversarial');
    expect(out).toHaveLength(0);
  });

  it('rejects a question whose declared level and span_role disagree', () => {
    // Asked for scenario (requires "principle"); the candidate declares "answer".
    expect(parseAt(good(), 'scenario')).toHaveLength(0);
    // Asked for recognition (requires "answer"); the candidate declares "principle".
    expect(parseAt(scenarioGood(), 'recognition')).toHaveLength(0);
    // Asked for adversarial (requires "claim"); the candidate declares "principle".
    expect(parseAt(scenarioGood(), 'adversarial')).toHaveLength(0);
    // Asked for free_recall (requires "answer"); the candidate declares "claim".
    expect(parseAt(adversarialGood(), 'free_recall')).toHaveLength(0);
  });

  it('rejects a question with no span_role at all, at every level', () => {
    for (const level of LEVELS) {
      expect(parseAt({ ...good(), span_role: undefined }, level)).toHaveLength(0);
    }
  });

  it('the verbatim check stays exact at scenario and adversarial too — no fuzzy matching anywhere', () => {
    expect(parseAt(
      scenarioGood({ span: 'The link between where eyes point and thought is weak but real.' }),
      'scenario',
    )).toHaveLength(0);
    expect(parseAt(
      adversarialGood({ span: 'A reader might fixate on a paragraph while daydreaming instead.' }),
      'adversarial',
    )).toHaveLength(0);
  });

  it('an unrecognised level falls back to recognition rather than inventing a fifth', () => {
    const out = parseAt(good(), 'omniscient');
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('recognition');
  });

  it("never lets the candidate's own declared level (if a model sends one anyway) override the caller's", () => {
    // The model has no business sending `level` at all, and nothing here
    // ever reads q.level — the caller's argument is the only source.
    const out = parseAt({ ...good(), level: 'adversarial' }, 'recognition');
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe('recognition');
  });

  it('validateQuestion rejects a null/non-object candidate at every level without throwing', () => {
    for (const level of LEVELS) {
      expect(validateQuestion(null, PASSAGE, level)).toBeNull();
      expect(validateQuestion('not an object', PASSAGE, level)).toBeNull();
    }
  });

  it('SPAN_ROLE_FOR_LEVEL covers exactly the four documented levels, no more, no fewer', () => {
    expect(LEVELS).toEqual(['recognition', 'free_recall', 'scenario', 'adversarial']);
    expect(Object.keys(SPAN_ROLE_FOR_LEVEL).sort()).toEqual([...LEVELS].sort());
    expect(SPAN_ROLE_FOR_LEVEL.recognition).toBe('answer');
    expect(SPAN_ROLE_FOR_LEVEL.free_recall).toBe('answer');
    expect(SPAN_ROLE_FOR_LEVEL.scenario).toBe('principle');
    expect(SPAN_ROLE_FOR_LEVEL.adversarial).toBe('claim');
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
