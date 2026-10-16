import { describe, it, expect } from 'vitest';
import { createInterventionPolicy } from '../alcoia/src/content/intervention-policy.js';

describe('return_check kind', () => {
  it('allows a quick check after a long absence, as a retrieval', () => {
    const p = createInterventionPolicy({});
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k', questionCardVisible: false, kind: 'return_check' });
    expect(d.allow).toBe(true);
    expect(d.action).toBe('return_check');
    expect(d.policyAction).toBe('retrieve');
  });
  it('never takes the last slot of the budget', () => {
    const p = createInterventionPolicy({});
    let last;
    for (let i = 0; i < 30; i++) {
      const d = p.evaluateRetentionCandidate({ paragraphKey: 'k' + i, questionCardVisible: false, kind: 'return_check' });
      if (!d.allow) break;
      p.record(d); last = d;
    }
    expect(last).toBeDefined();
    const blocked = p.evaluateRetentionCandidate({ paragraphKey: 'z', questionCardVisible: false, kind: 'return_check' });
    expect(blocked.allow).toBe(false);
  });
});
