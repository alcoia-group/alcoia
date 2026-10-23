import { describe, it, expect } from 'vitest';
import { createTransferTracker, SPACING_MS, SPACING_OTHER_PARAGRAPHS } from '../alcoia/src/shared/transfer-check.js';
import { chooseStyle } from '../alcoia/src/shared/explanation-style.js';
import { createOutcomesManager } from '../alcoia/src/shared/outcomes.js';
import { createInterventionPolicy, POLICY_ACTIONS } from '../alcoia/src/content/intervention-policy.js';
import { createPolicyProfileManager } from '../alcoia/src/shared/policy-profile.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('transfer tracker', () => {
  it('a unit becomes ready only after the spacing in paragraphs AND time', () => {
    const c = clock();
    const tr = createTransferTracker({ now: c.now });
    tr.noteExplained('u1', { text: 'Passage one.', mode: 'explain_more', style: 'analogy', paragraphIndex: 4 });
    for (let i = 0; i < SPACING_OTHER_PARAGRAPHS; i += 1) tr.noteParagraphRead(`o${i}`);
    expect(tr.readyUnits()).toEqual([]); // enough paragraphs, not enough time
    c.advance(SPACING_MS);
    expect(tr.readyUnits()).toEqual([{ unitId: 'u1', text: 'Passage one.', paragraphIndex: 4 }]);
  });
  it('reading the explained paragraph itself is not "another paragraph"', () => {
    const c = clock();
    const tr = createTransferTracker({ now: c.now });
    tr.noteExplained('u1', { text: 't', mode: 'repair', style: 'contrast' });
    tr.noteParagraphRead('u1'); tr.noteParagraphRead('u1'); tr.noteParagraphRead('o1');
    c.advance(SPACING_MS);
    expect(tr.readyUnits()).toEqual([]);
  });
  const ready = (tr, c) => { tr.noteParagraphRead('a'); tr.noteParagraphRead('b'); c.advance(SPACING_MS); };

  it('infers "helped" on success and "not helped" otherwise, once, for the style used', () => {
    const c = clock();
    const tr = createTransferTracker({ now: c.now });
    tr.noteExplained('u1', { text: 't', mode: 'explain_more', style: 'analogy' });
    ready(tr, c);
    expect(tr.settle('u1', true)).toEqual({ scope: 'style', key: 'explain_more:analogy', helpedInferred: 1 });
    expect(tr.settle('u1', true)).toBeNull(); // not twice
    tr.noteExplained('u2', { text: 't', mode: 'repair', style: 'contrast' });
    expect(tr.settle('u2', false)).toEqual({ scope: 'style', key: 'repair:contrast', notHelpedInferred: 1 });
  });
  it('an explicit tap wins: nothing is inferred (mutation target)', () => {
    const c = clock();
    const tr = createTransferTracker({ now: c.now });
    tr.noteExplained('u1', { text: 't', mode: 'explain_more', style: 'analogy' });
    tr.noteTap('u1');
    expect(tr.settle('u1', false)).toBeNull();
    expect(tr.avoidStyleFor('u1')).toBeNull(); // the reader's own tap already informs the profile
  });
  it('no style used (for example the relationship guide) means nothing to infer', () => {
    const tr = createTransferTracker();
    tr.noteExplained('u1', { text: 't', mode: 'relate', style: null });
    expect(tr.settle('u1', false)).toBeNull();
  });
  it('a failed check marks the style to avoid for that paragraph only; a new explanation starts afresh', () => {
    const tr = createTransferTracker();
    tr.noteExplained('u1', { text: 't', mode: 'explain_more', style: 'analogy' });
    tr.settle('u1', false);
    expect(tr.avoidStyleFor('u1')).toBe('analogy');
    expect(tr.avoidStyleFor('u2')).toBeNull();
  });
  it('is bounded in memory', () => {
    const tr = createTransferTracker();
    for (let i = 0; i < 100; i += 1) tr.noteExplained(`u${i}`, { text: 't', mode: 'repair', style: 'contrast' });
    expect(tr.isExplained('u0')).toBe(false);
    expect(tr.isExplained('u99')).toBe(true);
  });
});

describe('chooseStyle with a style to avoid', () => {
  const list = [{ style: 'scenario', n: 20 }, { style: 'analogy', n: 20 }, { style: 'contrast', n: 3 }];
  it('never returns the avoided style while another exists, and still explores under-tested ones', () => {
    expect(chooseStyle(list, () => 0.99, { avoid: 'scenario' })).toBe('analogy');
    expect(chooseStyle(list, () => 0.0, { avoid: 'scenario' })).toBe('contrast');
  });
  it('with only one style it is still returned', () => {
    expect(chooseStyle([{ style: 'scenario', n: 1 }], () => 0.9, { avoid: 'scenario' })).toBe('scenario');
  });
  it('is unchanged without the option', () => {
    expect(chooseStyle(list, () => 0.99)).toBe('scenario');
  });
});

describe('outcomes carries the transfer marker (closed list)', () => {
  const body = async (fields) => {
    let sent = null;
    const m = createOutcomesManager({ fetchImpl: async (u, i) => { sent = JSON.parse(i.body); return { ok: true, json: async () => ({}) }; }, outcomesUrl: 'https://x.invalid/o', getSession: async () => ({ token: 't' }) });
    await m.submit({ paragraphIndex: 1, questionId: 'q1', ...fields });
    return sent;
  };
  it('sends same_session and delayed, nothing else', async () => {
    expect((await body({ transferCheck: 'same_session' })).transfer_check).toBe('same_session');
    expect((await body({ transferCheck: 'delayed' })).transfer_check).toBe('delayed');
    expect(await body({ transferCheck: 'sometime' })).not.toHaveProperty('transfer_check');
    expect(await body({})).not.toHaveProperty('transfer_check');
  });
  it('never sends it without an answered question', async () => {
    let sent = null;
    const m = createOutcomesManager({ fetchImpl: async (u, i) => { sent = JSON.parse(i.body); return { ok: true, json: async () => ({}) }; }, outcomesUrl: 'https://x.invalid/o', getSession: async () => ({ token: 't' }) });
    await m.submit({ paragraphIndex: 1, transferCheck: 'delayed' });
    expect(sent).not.toHaveProperty('transfer_check');
  });
});

describe('policy: a transfer follow-up shares the budget and gates, and is not a new policy action', () => {
  const policy = (o = {}) => createInterventionPolicy({ now: () => 5_000_000, ...o });
  it('is allowed as a retrieval, with an id, on a paragraph that was already interrupted', () => {
    const p = policy();
    const first = p.evaluateRetentionCandidate({ paragraphKey: 'k', kind: 'retention' });
    p.record(first);
    const d = p.evaluateRetentionCandidate({ paragraphKey: 'k', kind: 'transfer' });
    // The minimum gap after the first card still applies: the shared cooldown is honoured.
    expect(d.allow).toBe(false);
    const fresh = policy().evaluateRetentionCandidate({ paragraphKey: 'k', kind: 'transfer' });
    expect(fresh).toMatchObject({ allow: true, action: 'transfer', policyAction: POLICY_ACTIONS.RETRIEVE });
    expect(typeof fresh.interventionId).toBe('string');
  });
  it('is denied while a question card is visible, and after repeated dismissals', () => {
    expect(policy().evaluateRetentionCandidate({ paragraphKey: 'k', kind: 'transfer', questionCardVisible: true }).allow).toBe(false);
    const p = policy();
    for (let i = 0; i < 5; i += 1) p.recordDismissal();
    expect(p.evaluateRetentionCandidate({ paragraphKey: 'k', kind: 'transfer' }).allow).toBe(false);
  });
  it('apply stays unreachable as a policy action', () => {
    const p = policy();
    expect(p.evaluateRetentionCandidate({ paragraphKey: 'k', kind: 'transfer' }).policyAction).not.toBe(POLICY_ACTIONS.APPLY);
  });
});

describe('policy profile reports inferred counts separately', () => {
  it('queues helpedInferred and notHelpedInferred next to the tap counts and never merges them', async () => {
    const posted = [];
    const m = createPolicyProfileManager({
      getSession: async () => ({ token: 't' }), eventsUrl: 'https://x.invalid/e', profileUrl: 'https://x.invalid/p', storage: null,
      fetchImpl: async (url, init) => { if (init.method === 'POST') posted.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; },
    });
    m.record({ scope: 'style', key: 'explain_more:analogy', helped: 1 });
    m.record({ scope: 'style', key: 'explain_more:analogy', helpedInferred: 2, notHelpedInferred: 1 });
    await m.ready; await new Promise((r) => setTimeout(r, 5));
    await m.flush();
    const e = posted[0].events[0];
    expect(e).toMatchObject({ key: 'explain_more:analogy', helped: 1, helpedInferred: 2, notHelpedInferred: 1, notHelped: 0 });
  });
});
