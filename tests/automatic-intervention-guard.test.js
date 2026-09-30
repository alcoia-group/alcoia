/* automatic-intervention-guard.js's own unit tests (Step 12A) — the module
 * in isolation, separate from host.test.js's integration-level proof that
 * handleAsk/checkRetentionCandidate actually use it correctly. */
import { describe, it, expect } from 'vitest';
import { createAutomaticInterventionGuard } from '../alcoia/src/content/automatic-intervention-guard.js';

describe('createAutomaticInterventionGuard()', () => {
  it('starts free', () => {
    const guard = createAutomaticInterventionGuard();
    expect(guard.isInFlight()).toBe(false);
  });

  it('tryAcquire() succeeds when free and marks it held', () => {
    const guard = createAutomaticInterventionGuard();
    expect(guard.tryAcquire()).toBe(true);
    expect(guard.isInFlight()).toBe(true);
  });

  it('a second tryAcquire() while held fails and does not disturb the first holder', () => {
    const guard = createAutomaticInterventionGuard();
    expect(guard.tryAcquire()).toBe(true);
    expect(guard.tryAcquire()).toBe(false);
    expect(guard.isInFlight()).toBe(true);
  });

  it('release() frees it for a subsequent acquire', () => {
    const guard = createAutomaticInterventionGuard();
    guard.tryAcquire();
    guard.release();
    expect(guard.isInFlight()).toBe(false);
    expect(guard.tryAcquire()).toBe(true);
  });

  it('release() on an already-free guard is a harmless no-op', () => {
    const guard = createAutomaticInterventionGuard();
    guard.release();
    expect(guard.isInFlight()).toBe(false);
    expect(guard.tryAcquire()).toBe(true);
  });

  it('two independent instances never share state', () => {
    const a = createAutomaticInterventionGuard();
    const b = createAutomaticInterventionGuard();
    expect(a.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(a.isInFlight()).toBe(true);
    expect(b.isInFlight()).toBe(true);
  });
});
