import { describe, it, expect } from 'vitest';
import { createDecisionLog, summarizeDecisions, sanitizeEntry } from '../alcoia/src/shared/decision-log.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    get: (keys, cb) => cb({ ...Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, data[k] ?? d])) }),
    set: (obj, cb) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb?.(); },
  };
}

describe('decision log', () => {
  it('stores only the fixed short fields, with urls stripped and numbers rounded', async () => {
    const storage = memoryStorage();
    const log = createDecisionLog({ storage, now: () => 5 });
    await log.record({ kind: 'decision', state: 'struggling', confidence: 0.678, basis: 'generic', action: 'ask', reason: 'see https://x.test/page now', text: 'PASSAGE TEXT', paragraphKey: 'secret' });
    const [e] = await log.list();
    expect(e).toEqual({ at: 5, kind: 'decision', state: 'struggling', confidence: 0.68, basis: 'generic', action: 'ask', policyAction: null, reason: 'see  now', previousState: null });
    expect(JSON.stringify(e)).not.toMatch(/PASSAGE|secret|x\.test/);
  });
  it('ignores unknown kinds, caps its size, and clears', async () => {
    const storage = memoryStorage();
    const log = createDecisionLog({ storage, maxEntries: 3 });
    await log.record({ kind: 'nonsense' });
    for (let i = 0; i < 6; i++) await log.record({ kind: 'shown', state: `s${i}` });
    expect(await log.list()).toHaveLength(3);
    expect((await log.list())[0].state).toBe('s5');
    await log.clear();
    expect(await log.list()).toEqual([]);
  });
  it('never throws without storage', async () => {
    await expect(createDecisionLog({ storage: null }).record({ kind: 'shown' })).resolves.toBeUndefined();
    expect(sanitizeEntry(null, 1)).toBe(null);
  });
});

describe('summarizeDecisions', () => {
  const e = (kind, over = {}) => ({ kind, ...over });
  it('reports proxies with denominators, never an accuracy figure', () => {
    const entries = [
      e('decision', { action: 'ask' }), e('decision', { action: 'hold', reason: 'session budget used' }), e('decision', { action: 'hold', reason: 'low confidence' }),
      e('shown', { basis: 'generic' }), e('shown', { basis: 'personal_z' }), e('dismissed', { basis: 'generic' }), e('answered', { basis: 'personal_z' }),
      e('self_report', { previousState: 'on_pace' }), e('self_report', { previousState: 'struggling' }),
    ];
    const s = summarizeDecisions(entries);
    expect(s).toMatchObject({ allowed: 1, withheld: 2, withheldByPolicyRule: 1, shown: 2, dismissed: 1, answered: 1, dismissRate: 0.5, selfReports: 2, selfReportsWhileDetectorQuiet: 1, selfReportsWhileDetectorQuietRate: 0.5 });
    expect(s.byBasis.generic).toEqual({ shown: 1, dismissed: 1, dismissRate: 1 });
    expect(s.byBasis.personal_z).toEqual({ shown: 1, dismissed: 0, dismissRate: 0 });
    const { note, ...numbers } = s; expect(JSON.stringify(numbers)).not.toMatch(/accura|precision|recall/i);
  });
  it('rates are null with no data', () => {
    expect(summarizeDecisions([]).dismissRate).toBe(null);
  });
});
