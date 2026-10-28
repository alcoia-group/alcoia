import { describe, it, expect } from 'vitest';
import * as mod from '../alcoia/src/shared/grading-client.js';

const PASSAGE = 'The relationship between where the eyes point and what the mind does is real but weak. More text follows here.';
const SPAN = 'The relationship between where the eyes point and what the mind does is real but weak.';
const make = (data) => mod.createGradingClient({
  callBackend: async () => ({ ok: true, data }),
  getGradeUrl: () => 'http://x/api/check-answer',
  checkBudget: () => true,
});
const call = (client, level) => client.fetchGrading({ passage: PASSAGE, span: SPAN, spanRole: 'principle', question: 'q', answer: 'the opposite claim', level });

describe('grading client: wrong at scenario level', () => {
  it('an incorrect without a confirmed contradiction stays unconfirmed', async () => {
    expect((await call(make({ verdict: 'incorrect', span: SPAN }), 'scenario')).verdict).toBe('unknown');
  });
  it('an incorrect with basis contradiction is passed through', async () => {
    expect(await call(make({ verdict: 'incorrect', span: SPAN, basis: 'contradiction' }), 'scenario')).toEqual({ verdict: 'incorrect', span: SPAN, basis: 'contradiction' });
  });
  it('free recall is unchanged', async () => {
    expect(await call(make({ verdict: 'incorrect', span: SPAN }), 'free_recall')).toEqual({ verdict: 'incorrect', span: SPAN });
  });
  it('a contradiction whose principle is not in the passage is dropped', async () => {
    expect((await call(make({ verdict: 'incorrect', span: 'A sentence that is not in the passage at all.', basis: 'contradiction' }), 'scenario')).verdict).toBe('unknown');
  });
});
