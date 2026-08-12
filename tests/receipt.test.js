import { describe, it, expect } from 'vitest';
import {
  buildReceipt, hashUrl, auditReceipt, receiptIsSubstantive, canonicalise, RECEIPT_VERSION,
} from '../alcoia/src/content/receipt.js';
import Sig from './contract/receipt-signing.js';

const SOURCES = {
  session: { startedAt: 1_700_000_000_000, durationMs: 600_000 },
  recall: { asked: 4, answered: 3, correct: 2, dismissed: 1, medianLatencyMs: 8200 },
  recallItems: [
    { correct: true, latencyMs: 5000, revisions: 0, scrolledBack: false, span: 'A sentence from the page.' },
    { correct: false, latencyMs: 12000, revisions: 2, scrolledBack: true, span: 'Another sentence.' },
    { correct: null, latencyMs: 900, span: 'Dismissed one.' },
  ],
  reading: { paragraphsSeen: 14, paragraphsRead: 9, struggled: 3 },
  progression: { normalized: 0.8123, shape: 'reading', meanDwellMs: 14300.7 },
  regressions: { regressions: 5 },
  interaction: { blurEvents: 4, longBlurEvents: 1 },
  document: { title: 'On the measurement of reading', url: 'https://example.com/a/b?c=d', wordCount: 1800, paragraphs: 12 },
  now: 1_700_000_600_000,
};

describe('buildReceipt', () => {
  const r = buildReceipt(SOURCES);

  it('never includes the URL, only a hash of it', () => {
    const json = JSON.stringify(r);
    expect(json).not.toContain('example.com');
    expect(json).not.toContain('?c=d');
    expect(r.document.urlHash).toMatch(/^u[0-9a-f]+$/);
  });

  it('hashes consistently and distinguishes pages', () => {
    expect(hashUrl('https://a.test/x')).toBe(hashUrl('https://a.test/x'));
    expect(hashUrl('https://a.test/x')).not.toBe(hashUrl('https://a.test/y'));
  });

  it('carries the recall block as the substance', () => {
    expect(r.recall.questionsAsked).toBe(4);
    expect(r.recall.correct).toBe(2);
    expect(r.recall.medianLatencyMs).toBe(8200);
    // Dismissed questions are not scored, so they are not recall items.
    expect(r.recall.items).toHaveLength(2);
  });

  it('computes coverage from paragraphs read against the page', () => {
    expect(r.session.paragraphsReached).toBe(9);
    expect(r.session.coveragePct).toBe(75);
  });

  it('never reports coverage above 100% when tracking overcounts', () => {
    const odd = buildReceipt({ ...SOURCES, reading: { paragraphsRead: 40 }, document: { ...SOURCES.document, paragraphs: 12 } });
    expect(odd.session.coveragePct).toBe(100);
  });

  it('abstains rather than dividing by zero', () => {
    const empty = buildReceipt({ document: { title: 't', url: 'u' } });
    expect(empty.session.coveragePct).toBeNull();
    expect(empty.recall.medianLatencyMs).toBeNull();
    expect(empty.recall.items).toEqual([]);
  });

  it('carries the caveat as part of the artifact', () => {
    expect(r.caveat).toMatch(/does not verify/i);
    expect(r.version).toBe(RECEIPT_VERSION);
  });
});

/* Invariant 6: no raw gaze coordinates in any persisted or transmitted
 * artifact. The audit is a backstop against a future change upstream. */
describe('auditReceipt', () => {
  it('passes a clean receipt', () => {
    expect(auditReceipt(buildReceipt(SOURCES))).toEqual([]);
  });

  it('catches raw sensor fields', () => {
    const dirty = buildReceipt(SOURCES);
    dirty.engagement.gaze = [{ x: 12, y: 40 }];
    const problems = auditReceipt(dirty);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/gaze/);
  });

  it('catches a full URL sneaking in', () => {
    const dirty = buildReceipt(SOURCES);
    dirty.document.source = 'https://example.com/private/page';
    expect(auditReceipt(dirty).join(' ')).toMatch(/full URL/);
  });
});

describe('receiptIsSubstantive', () => {
  it('is false when nothing was answered — coverage alone is not evidence', () => {
    const noRecall = buildReceipt({ ...SOURCES, recall: { asked: 2, answered: 0 }, recallItems: [] });
    expect(receiptIsSubstantive(noRecall)).toBe(false);
  });

  it('is true once a question has been answered', () => {
    expect(receiptIsSubstantive(buildReceipt(SOURCES))).toBe(true);
  });
});

describe('canonicalise', () => {
  it('is independent of key order', () => {
    expect(canonicalise({ b: 1, a: 2 })).toBe(canonicalise({ a: 2, b: 1 }));
  });

  it('survives a JSON round trip', () => {
    const r = buildReceipt(SOURCES);
    expect(canonicalise(JSON.parse(JSON.stringify(r)))).toBe(canonicalise(r));
  });

  it('matches the server\'s implementation, or nothing would ever verify', () => {
    const r = buildReceipt(SOURCES);
    expect(canonicalise(r)).toBe(Sig.canonicalise(r));
  });
});

describe('signing', () => {
  const SECRET = 'test-secret-not-a-real-key';
  const receipt = buildReceipt(SOURCES);

  it('signs and verifies a round trip', () => {
    const signed = Sig.sign(receipt, SECRET);
    expect(signed.signature.alg).toBe('HMAC-SHA256');
    expect(Sig.verify(signed, SECRET).valid).toBe(true);
  });

  it('says what it proves, in the artifact', () => {
    expect(Sig.sign(receipt, SECRET).signature.note).toMatch(/Does not verify/i);
  });

  it('detects any edit to the numbers', () => {
    const signed = Sig.sign(receipt, SECRET);
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.recall.correct = 99;
    const result = Sig.verify(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('altered_since_issue');
  });

  it('detects a forged signature value', () => {
    const signed = Sig.sign(receipt, SECRET);
    signed.signature.value = 'AAAA';
    expect(Sig.verify(signed, SECRET).valid).toBe(false);
  });

  it('rejects a receipt signed with a different secret', () => {
    const signed = Sig.sign(receipt, 'some-other-secret');
    expect(Sig.verify(signed, SECRET).valid).toBe(false);
  });

  it('is idempotent — signing a signed receipt verifies', () => {
    const once = Sig.sign(receipt, SECRET);
    const twice = Sig.sign(once, SECRET);
    expect(Sig.verify(twice, SECRET).valid).toBe(true);
  });

  it('reports an unsigned receipt as unsigned rather than invalid', () => {
    expect(Sig.verify(receipt, SECRET).reason).toBe('unsigned');
  });

  it('refuses to sign without a secret', () => {
    expect(() => Sig.sign(receipt, '')).toThrow(/secret/i);
    expect(Sig.verify(Sig.sign(receipt, SECRET), '').valid).toBe(false);
  });

  it('survives a JSON round trip, which is how a receipt actually travels', () => {
    const signed = JSON.parse(JSON.stringify(Sig.sign(receipt, SECRET)));
    expect(Sig.verify(signed, SECRET).valid).toBe(true);
  });
});
