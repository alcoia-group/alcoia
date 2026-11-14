// BETA-FEEDBACK: this whole file goes when the beta ends.
import { describe, it, expect } from 'vitest';
import { createBetaFeedback } from '../alcoia/src/shared/beta-feedback.js';

function memStorage(init = {}) {
  const store = { ...init };
  return { store, get(keys, cb) { const r = {}; for (const [k, d] of Object.entries(keys)) r[k] = k in store ? store[k] : d; cb(r); }, set(o, cb) { Object.assign(store, o); cb?.(); } };
}
function make({ open = true, session = { token: 't' }, storage = memStorage(), t = { now: 1_000_000 }, assignmentId = null } = {}) {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ open }) };
    sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ recorded: true }) };
  };
  const bf = createBetaFeedback({ getSession: async () => session, fetchImpl, statusUrl: 'x/status', postUrl: 'x/beta-feedback', storage, now: () => t.now, assignmentId });
  return { bf, sent, storage, t };
}

describe('beta feedback (client)', () => {
  it('asks only when open, signed in, a card was shown, and not in the last 30 minutes', async () => {
    expect(await make().bf.shouldAsk()).toBe(false); // no card yet
    const a = make();
    a.bf.noteCard('iv1', { type: 'ask', text: 'one two' });
    expect(await a.bf.shouldAsk()).toBe(true);
    await a.bf.markAsked();
    expect(await a.bf.shouldAsk()).toBe(false); // once per page
    const b = make({ storage: a.storage, t: { now: a.t.now + 10 * 60 * 1000 } });
    b.bf.noteCard('iv2', { type: 'ask' });
    expect(await b.bf.shouldAsk()).toBe(false); // 10 minutes later, another page
    const c = make({ storage: a.storage, t: { now: a.t.now + 31 * 60 * 1000 } });
    c.bf.noteCard('iv3', { type: 'ask' });
    expect(await c.bf.shouldAsk()).toBe(true);
    const closed = make({ open: false }); closed.bf.noteCard('i', { type: 'ask' });
    expect(await closed.bf.shouldAsk()).toBe(false);
    const signedOut = make({ session: null }); signedOut.bf.noteCard('i', { type: 'ask' });
    expect(await signedOut.bf.shouldAsk()).toBe(false);
  });

  it('sends the trigger of the chosen card, never its words, and names the paragraph only in an assignment', async () => {
    const t = { now: 5_000_000 };
    const { bf, sent } = make({ t });
    bf.noteCard('a', { type: 'explain', policyAction: 'explain', unitId: 'k_1', text: 'secret words from the page' });
    t.now += 90_000;
    bf.noteCard('b', { type: 'ask', policyAction: 'retrieve', unitId: 'k_2', text: 'more page words' });
    bf.noteDetector('b', 'struggling', 'personal_z');
    expect(await bf.send('wrong_moment', 'yes', { card: bf.list()[1], situation: 'thinking', note: ' busy ' })).toBe(true);
    expect(sent[0]).toEqual({ surface: 'extension', kind: 'wrong_moment', answer: 'yes', note: 'busy',
      details: { cardType: 'question', detectorState: 'struggling', detectorBasis: 'personal_z', policyAction: 'retrieve', baseline: 'personal', secondsSinceLastCard: 90, situation: 'thinking' } });
    expect(JSON.stringify(sent)).not.toMatch(/page words|k_2/);

    const inClass = make({ assignmentId: 'asg-1' });
    inClass.bf.noteCard('c', { type: 'probe', unitId: 'k_9' });
    await inClass.bf.send('wrong_moment', 'yes', { card: inClass.bf.list()[0] });
    expect(inClass.sent[0]).toMatchObject({ assignmentId: 'asg-1', knowledgeUnitId: 'k_9', details: { cardType: 'probe' } });
  });

  it('"Don\'t ask me these again" turns the setting off', async () => {
    const { bf, storage } = make();
    bf.noteCard('a', { type: 'ask' });
    await bf.turnOff();
    expect(storage.store.sra_beta_questions).toBe(false);
    expect(await bf.shouldAsk()).toBe(false);
  });
});
