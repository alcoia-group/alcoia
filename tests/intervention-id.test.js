/* intervention-id.js — a unique identity for one presented intervention
 * (intelligence-architecture audit, step 5). See that file's own header for
 * why this is randomness-plus-timestamp, not a content hash like
 * knowledge-unit.js's computeKnowledgeUnitId. */
import { describe, it, expect } from 'vitest';
import { generateInterventionId } from '../alcoia/src/content/signals/intervention-id.js';

describe('generateInterventionId', () => {
  it('produces a different id on every call, even with identical inputs otherwise available to it', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateInterventionId()));
    expect(ids.size).toBe(200);
  });

  it('is NOT a content hash — the same "now"/"random" pair used twice still differs is not required, but calling it twice for the SAME conceptual event (e.g. the same paragraph asked about twice) must never coincidentally collide in practice', () => {
    // Two calls with a fixed `now` but real randomness — simulates two
    // interventions presented in the same millisecond, the tightest
    // real-world case.
    const fixedNow = () => 1700000000000;
    const a = generateInterventionId(fixedNow);
    const b = generateInterventionId(fixedNow);
    expect(a).not.toBe(b);
  });

  it('carries the "iv_" prefix, distinguishing it from quiz-store.js ids ("q_...") and knowledge-unit ids ("k...") at a glance', () => {
    const id = generateInterventionId();
    expect(id).toMatch(/^iv_\d+_[0-9a-z]+$/);
  });

  it('embeds a real timestamp when a deterministic `now` is injected, for the same testability reason quiz-store.js\'s own randomId() accepts one', () => {
    const id = generateInterventionId(() => 1700000000000, () => 0.123456789);
    expect(id.startsWith('iv_1700000000000_')).toBe(true);
  });

  it('contains no account id, email, or pseudonym — the id is a pure function of time and randomness only', () => {
    const id = generateInterventionId(() => 1700000000000, () => 0.5);
    // Nothing resembling an email or a long hex/base64 pseudonym-shaped
    // string appears anywhere in the value.
    expect(id).not.toMatch(/@/);
    expect(id.length).toBeLessThan(40);
  });
});
