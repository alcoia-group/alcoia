/* Item 22 found session-report.js's STATE_COLORS/STATE_LABELS keyed on
 * focused/confused/zoning_out/overloaded — state names the engine has not
 * emitted since the gaze classifier was removed. Before the fix the whole
 * script was CSP-dead (item 21), so the bug was invisible; after item 21
 * made the script run, it became a live failure: the state bar rendered
 * empty, because none of those keys ever matched a real
 * session.stateDurations field.
 *
 * This test derives the valid key set from state-engine.js's own STATES
 * export rather than hard-coding a copy of it here, so a future rename of
 * the engine's vocabulary breaks this test — and therefore the build —
 * instead of silently breaking the page the way this one did. */
import { describe, it, expect } from 'vitest';
import { STATES } from '../alcoia/src/content/state-engine.js';
import { STATE_COLORS, STATE_LABELS } from '../alcoia/src/popup/session-report-state.js';

const engineStates = Object.values(STATES);

describe('session-report state vocabulary', () => {
  it('the engine actually exports the six states this test relies on', () => {
    // Sanity check on the derivation itself — if state-engine.js's export
    // shape ever changes, this fails loudly instead of engineStates
    // silently becoming an empty or wrong array.
    expect(engineStates.length).toBeGreaterThanOrEqual(6);
    expect(engineStates).toContain('unknown');
  });

  it('every STATE_COLORS key is a state the engine can actually emit', () => {
    for (const key of Object.keys(STATE_COLORS)) {
      expect(engineStates).toContain(key);
    }
  });

  it('every STATE_LABELS key is a state the engine can actually emit', () => {
    for (const key of Object.keys(STATE_LABELS)) {
      expect(engineStates).toContain(key);
    }
  });

  it('every engine state has a colour and a label — nothing is silently dropped', () => {
    for (const state of engineStates) {
      expect(STATE_COLORS).toHaveProperty(state);
      expect(STATE_LABELS).toHaveProperty(state);
    }
  });

  it('unknown is represented, not hidden or folded into another state', () => {
    // Invariant 5: unknown is a valid, correct, common answer. A report
    // that erased it would be reporting something the engine didn't
    // actually observe.
    expect(STATE_COLORS).toHaveProperty('unknown');
    expect(STATE_LABELS.unknown).toBe('Unknown');
  });

  it('never reintroduces the removed camera-classifier vocabulary', () => {
    const removed = ['focused', 'confused', 'zoning_out', 'overloaded'];
    for (const name of removed) {
      expect(STATE_COLORS).not.toHaveProperty(name);
      expect(STATE_LABELS).not.toHaveProperty(name);
    }
  });
});
