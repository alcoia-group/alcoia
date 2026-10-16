import { describe, it, expect, vi } from 'vitest';
import { createPolicyProfileManager } from '../alcoia/src/shared/policy-profile.js';
import { createPoolReporter } from '../alcoia/src/shared/pool-counters.js';
import { createExposureReporter } from '../alcoia/src/shared/exposure.js';
import { createInterventionPolicy } from '../alcoia/src/content/intervention-policy.js';
import { STATES } from '../alcoia/src/content/state-engine.js';
import { summarizeDecisions } from '../alcoia/src/shared/decision-log.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    get: (keys, cb) => cb(Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, data[k] ?? d]))),
    set: (obj, cb) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb?.(); },
  };
}
const session = (token) => async () => (token ? { token } : null);
const ok = (json) => ({ ok: true, status: 200, json: async () => json });

describe('policy profile manager (the learner\'s adaptation follows their account)', () => {
  const profile = { cards: { probe: { n: 9, cooldownFactor: 2, withhold: true } }, detectors: {}, sensitivity: 1.1 };

  it('sends only counts, then refreshes the profile the policy reads', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); return init.method === 'POST' ? ok({ recorded: 1 }) : ok(profile); });
    const onChange = vi.fn();
    const m = createPolicyProfileManager({ getSession: session('tok'), profileUrl: 'https://s/profile', eventsUrl: 'https://s/events', fetchImpl, storage: memoryStorage(), onChange });
    m.record({ scope: 'card', key: 'probe', shown: 1, dismissed: 1, quickDismissed: 1 });
    m.record({ scope: 'card', key: 'probe', shown: 1 });
    expect(await m.flush()).toBe(true);
    const post = calls.find((c) => c.init.method === 'POST');
    expect(JSON.parse(post.init.body)).toEqual({ events: [{ scope: 'card', key: 'probe', shown: 2, answered: 0, dismissed: 1, quickDismissed: 1, correct: 0, selfReports: 0 }] });
    expect(post.init.headers.Authorization).toBe('Bearer tok');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 1.1 }));
    expect(m.getProfile().cards.probe.withhold).toBe(true);
    expect(m.pendingCount()).toBe(0);
  });

  it('keeps counts it could not send, and survives a closed tab (they are stored)', async () => {
    const storage = memoryStorage();
    const down = vi.fn(async () => ({ ok: false, status: 503, json: async () => null }));
    const a = createPolicyProfileManager({ getSession: session('tok'), profileUrl: 'u', eventsUrl: 'e', fetchImpl: down, storage });
    a.record({ scope: 'card', key: 'ask', shown: 3 });
    expect(await a.flush()).toBe(false);
    expect(a.pendingCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    const fetchImpl = vi.fn(async (url, init) => (init.method === 'POST' ? ok({}) : ok(profile)));
    const b = createPolicyProfileManager({ getSession: session('tok'), profileUrl: 'u', eventsUrl: 'e', fetchImpl, storage });
    expect(await b.flush()).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls.find((c) => c[1].method === 'POST')[1].body).events[0]).toMatchObject({ key: 'ask', shown: 3 });
  });

  it('sends nothing and learns nothing without a signed-in account', async () => {
    const fetchImpl = vi.fn();
    const m = createPolicyProfileManager({ getSession: session(null), profileUrl: 'u', eventsUrl: 'e', fetchImpl, storage: memoryStorage() });
    m.record({ scope: 'card', key: 'ask', shown: 1 });
    expect(await m.flush()).toBe(false);
    expect(await m.load()).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a 403 (learner memory off) leaves the policy at its starting values', async () => {
    const m = createPolicyProfileManager({ getSession: session('t'), profileUrl: 'u', eventsUrl: 'e', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), storage: null });
    expect(await m.load()).toBe(null);
    expect(m.getProfile().sensitivity).toBe(1);
  });
});

describe('evidence pool reporter', () => {
  it('sends nothing while the SERVER says the pool is off, and keeps nothing for later', async () => {
    const storage = memoryStorage();
    const callBackend = vi.fn();
    const r = createPoolReporter({ callBackend, fetchImpl: async () => ok({ enabled: false }), statusUrl: 's', countersUrl: 'c', storage });
    r.add('card_dismissed', 'probe');
    expect(await r.flush()).toBe(false);
    expect(callBackend).not.toHaveBeenCalled();
    expect(r.pendingCount()).toBe(0);
  });
  it('when on, sends closed-list counts through the install-token path', async () => {
    const callBackend = vi.fn(async () => ({ ok: true }));
    const r = createPoolReporter({ callBackend, fetchImpl: async () => ok({ enabled: true }), statusUrl: 's', countersUrl: 'c', storage: memoryStorage() });
    r.add('card_dismissed', 'probe'); r.add('card_dismissed', 'probe'); r.add('generation_failure', 'questions');
    r.add('not_a_metric', 'x'); r.add('card_shown', '');
    expect(await r.flush()).toBe(true);
    expect(callBackend).toHaveBeenCalledWith('apiPost', 'c', { counters: [{ metric: 'card_dismissed', dimension: 'probe', value: 2 }, { metric: 'generation_failure', dimension: 'questions', value: 1 }] });
  });
  it('an unreadable status means off', async () => {
    const r = createPoolReporter({ callBackend: vi.fn(), fetchImpl: async () => ({ ok: false }), statusUrl: 's', countersUrl: 'c', storage: null });
    expect(await r.enabled()).toBe(false);
  });
});

describe('exposure reporter', () => {
  it('reports each paragraph id once, in batches, with only ids', async () => {
    const fetchImpl = vi.fn(async () => ok({ recorded: 1 }));
    const e = createExposureReporter({ getSession: session('t'), exposureUrl: 'x', fetchImpl, batchSize: 3 });
    for (const id of ['a', 'b', 'a', 'c']) e.note(id);
    await e.flush();
    await new Promise((r) => setTimeout(r, 0));
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies.flatMap((b) => b.unitIds).sort()).toEqual(['a', 'b', 'c']);
    expect(Object.keys(bodies[0])).toEqual(['unitIds']);
  });
  it('does nothing without a session', async () => {
    const fetchImpl = vi.fn();
    const e = createExposureReporter({ getSession: session(null), exposureUrl: 'x', fetchImpl, batchSize: 1 });
    e.note('a');
    await e.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the policy adapts to THIS learner', () => {
  const struggling = (o = {}) => ({ label: STATES.STRUGGLING, confidence: 0.62, evidence: ['x'], detectionBasis: 'generic', signal: {}, ...o });
  const mk = () => { let t = 1_000_000; const p = createInterventionPolicy({ now: () => t }); return { p, advance: (ms) => { t += ms; } }; };

  it('with no profile, nothing changes', () => {
    const { p } = mk();
    expect(p.evaluate(struggling(), {}).allow).toBe(true);
  });

  it('trusts a reading state less when its cards keep being unneeded for this learner', () => {
    const { p } = mk();
    p.setAdaptation({ cards: {}, detectors: { 'struggling:generic': { confidenceFactor: 0.75 } }, sensitivity: 1 });
    const d = p.evaluate(struggling({ confidence: 0.62 }), {});
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/confidence 0\.4\d below 0\.5/);
    expect(p.evaluate(struggling({ confidence: 0.8 }), {}).allow).toBe(true);
  });

  it('trusts the detector more for a learner who reports difficulty it missed', () => {
    const { p } = mk();
    p.setAdaptation({ cards: {}, detectors: {}, sensitivity: 1.2 });
    expect(p.evaluate(struggling({ confidence: 0.45 }), {}).allow).toBe(true);
  });

  it('waits longer between cards of a kind this learner keeps turning away', () => {
    const { p, advance } = mk();
    p.setAdaptation({ cards: { ask: { cooldownFactor: 2, withhold: false } }, detectors: {}, sensitivity: 1 });
    const first = p.evaluate(struggling(), { currentEl: null });
    p.record({ ...first, paragraphKey: 'p1' });
    advance(200_000); // past the starting 3 minutes, not past 6
    expect(p.evaluate(struggling({ signal: { paragraphKey: 'p2' } }), {}).allow).toBe(false);
    advance(200_000);
    expect(p.evaluate(struggling({ signal: { paragraphKey: 'p3' } }), {}).allow).toBe(true);
  });

  it('a kind this learner reliably turns away is held back, unless their own evidence says help is needed', () => {
    const { p } = mk();
    p.setAdaptation({ cards: { ask: { cooldownFactor: 3, withhold: true } }, detectors: {}, sensitivity: 1 });
    expect(p.evaluate(struggling(), {}).allow).toBe(false);
    expect(p.evaluate(struggling(), { learnerEstimate: { level: 'needs_help', action: 'intervene', kind: 'repair' } }).allow).toBe(true);
  });

  it('listens to dismissals sooner for someone who turns questions away, and gives an engaged learner more room', () => {
    const impatient = mk().p;
    impatient.setAdaptation({ cards: { ask: { cooldownFactor: 3, withhold: false } }, detectors: {}, sensitivity: 1 });
    impatient.recordDismissal(); impatient.recordDismissal();
    expect(impatient.evaluate(struggling({ confidence: 0.7 }), {}).allow).toBe(false); // stops after 2 for this learner
    const engaged = mk().p;
    engaged.setAdaptation({ cards: { ask: { cooldownFactor: 0.6, withhold: false } }, detectors: {}, sensitivity: 1 });
    engaged.recordDismissal(); engaged.recordDismissal(); engaged.recordDismissal();
    expect(engaged.evaluate(struggling({ confidence: 0.9 }), {}).allow).toBe(true); // starting values would have stopped at 3
  });

  it('what the learner has shown on the CONCEPT moves how readily a struggle becomes a card', () => {
    const { p } = mk();
    const known = { level: 'abstain-less', action: 'gather', kind: 'retrieve', reason: 'x', concept: { confidenceFactor: 0.75 } };
    expect(p.evaluate(struggling({ confidence: 0.62 }), { learnerEstimate: known }).allow).toBe(false);
    const unknown = { ...known, concept: { confidenceFactor: 1.25 } };
    expect(p.evaluate(struggling({ confidence: 0.45 }), { learnerEstimate: unknown }).allow).toBe(true);
  });

  it('a light check keeps the card a retrieval and says so', () => {
    const { p } = mk();
    const d = p.evaluate(struggling(), { learnerEstimate: { level: 'insufficient', action: 'gather', kind: 'retrieve', light: true, reason: 'concept_flagged_not_yet_retained' } });
    expect(d.allow).toBe(true);
    expect(d.light).toBe(true);
    expect(d.policyAction).toBe('retrieve');
  });

  it('a concept the learner reliably does not know turns a retrieval into an explanation', () => {
    const { p } = mk();
    const d = p.evaluate(struggling(), { learnerEstimate: { level: 'insufficient', action: 'intervene', kind: 'explain', reason: 'concept_reliably_not_known' } });
    expect(d.policyAction).toBe('explain');
  });

  it('a concept the learner reliably knows abstains even with no evidence on this paragraph', () => {
    const { p } = mk();
    expect(p.evaluate(struggling(), { learnerEstimate: { level: 'insufficient', action: 'abstain', reason: 'concept_reliably_known' } }).allow).toBe(false);
  });

  it('instructor-flagged concepts: known means a light check, unknown means help first, and a withheld kind stays withheld unless help is needed', () => {
    const { p } = mk();
    const light = p.evaluateRetentionCandidate({ kind: 'focus', mode: 'light', paragraphKey: 'a' });
    expect(light).toMatchObject({ allow: true, action: 'focus', light: true });
    const support = p.evaluateRetentionCandidate({ kind: 'focus', mode: 'support', paragraphKey: 'b' });
    expect(support).toMatchObject({ allow: true, action: 'focus', policyAction: 'explain' });
    const repair = p.evaluateRetentionCandidate({ kind: 'focus', mode: 'repair', paragraphKey: 'c' });
    expect(repair.policyAction).toBe('repair');
    p.setAdaptation({ cards: { focus: { cooldownFactor: 3, withhold: true } }, detectors: {}, sensitivity: 1 });
    expect(p.evaluateRetentionCandidate({ kind: 'focus', mode: 'normal', paragraphKey: 'd' }).allow).toBe(false);
    expect(p.evaluateRetentionCandidate({ kind: 'focus', mode: 'support', paragraphKey: 'e' }).allow).toBe(true);
  });

  it('quick checks and reviews respect the learner\'s profile for their own kind', () => {
    const { p } = mk();
    p.setAdaptation({ cards: { probe: { cooldownFactor: 3, withhold: true }, retention: { cooldownFactor: 1, withhold: false } }, detectors: {}, sensitivity: 1 });
    expect(p.evaluateRetentionCandidate({ kind: 'probe', paragraphKey: 'a' }).allow).toBe(false);
    expect(p.evaluateRetentionCandidate({ kind: 'retention', paragraphKey: 'b' }).allow).toBe(true);
  });

  it('ignores a malformed profile instead of breaking', () => {
    const { p } = mk();
    p.setAdaptation({ cards: { ask: { cooldownFactor: 'x', withhold: 'yes' } }, detectors: { 'a:b': null }, sensitivity: 'NaN' });
    expect(p.evaluate(struggling(), {}).allow).toBe(true);
    p.setAdaptation(undefined);
    expect(p.evaluate(struggling({ signal: { paragraphKey: 'z' } }), {}).allow).toBe(true);
  });
});

describe('decision log by card type', () => {
  it('shows which kinds of card get turned away', () => {
    const e = [
      { kind: 'shown', cardType: 'probe' }, { kind: 'shown', cardType: 'probe' }, { kind: 'dismissed', cardType: 'probe' }, { kind: 'dismissed', cardType: 'probe' },
      { kind: 'shown', cardType: 'ask' }, { kind: 'answered', cardType: 'ask' },
    ];
    const s = summarizeDecisions(e);
    expect(s.byCardType.probe).toEqual({ shown: 2, answered: 0, dismissed: 2, dismissRate: 1 });
    expect(s.byCardType.ask).toEqual({ shown: 1, answered: 1, dismissed: 0, dismissRate: 0 });
  });
});
