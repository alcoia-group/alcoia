/* BETA-FEEDBACK: this whole file goes when the beta ends (alcoiaServer docs/beta-feedback-plan.md, "Removing it").
 *
 * The beta question asked once at the end of a reading: "Did Alcoia interrupt you at a bad time?" and, if yes,
 * which card and what was going on. It keeps, in memory only, the cards shown on this page and what triggered each
 * one (card type, the detector's state and basis, the policy action, time since the previous card). When the reader
 * picks a card, that trigger is sent with the answer. The first words of each card are shown on this device to help
 * the reader recognise it; they are never sent. A paragraph is named (its knowledge unit) only inside an assigned
 * reading, where the server already holds the text; on an ordinary page nothing about the page is sent.
 *
 * Asked only when: the server says the beta is open, the reader is signed in, their "Beta questions" setting is not
 * off, at least one card was shown on this page, and no beta question was asked in the last 30 minutes.
 * Never throws. */
export const SETTING_KEY = 'sra_beta_questions';
const LAST_ASKED_KEY = 'sra_beta_last_asked';
const STATUS_TTL = 60 * 60 * 1000;
const GAP_MS = 30 * 60 * 1000;

const CARD_TYPE = {
  ask: 'question', focus: 'question', transfer: 'question', retrieve: 'question',
  explain: 'explanation', repair: 'explanation',
  retention: 'review', session_recall: 'review',
  probe: 'probe', return_check: 'return_check',
};
export const CARD_LABEL = {
  question: 'Question', explanation: 'Explanation', review: 'Review question', probe: 'Quick check', return_check: 'Welcome-back question', other: 'Card',
};
export const SITUATIONS = [
  ['reading_fine', 'I was reading fine'],
  ['thinking', 'I was thinking it over'],
  ['looked_up', 'I had just looked something up'],
  ['other', 'Something else'],
];

const firstWords = (text, n = 8) => {
  const w = String(text || '').trim().split(/\s+/).filter(Boolean);
  return w.length ? w.slice(0, n).join(' ') + (w.length > n ? '…' : '') : '';
};

export function createBetaFeedback(opts = {}) {
  const getSession = opts.getSession;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const statusUrl = opts.statusUrl;
  const postUrl = opts.postUrl;
  const surface = opts.surface === 'workspace' ? 'workspace' : 'extension';
  const assignmentId = opts.assignmentId || null;
  const now = opts.now || (() => Date.now());
  const storage = opts.storage === undefined ? (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null) : opts.storage;
  const sget = (k, d) => new Promise((resolve) => { try { storage.get({ [k]: d }, (r) => resolve(r[k])); } catch (e) { resolve(d); } });
  const sset = (o) => new Promise((resolve) => { try { storage.set(o, () => resolve()); } catch (e) { resolve(); } });

  const cards = []; // { id, type, policyAction, unitId, words, at, state, basis }
  let status = null; // { open, at }
  let askedThisPage = false;

  function noteCard(id, { type, policyAction, unitId, text } = {}) {
    if (!id) return;
    cards.push({ id, type: CARD_TYPE[type] || 'other', policyAction: policyAction || null, unitId: unitId || null, words: firstWords(text), at: now(), state: null, basis: null });
    if (cards.length > 40) cards.shift();
  }
  function noteDetector(id, state, basis) {
    const c = cards.find((x) => x.id === id);
    if (c && state) { c.state = state; c.basis = basis || null; }
  }
  const list = () => cards.map((c) => ({ ...c }));

  async function session() {
    try { const s = await getSession?.(); return s && typeof s.token === 'string' && s.token ? s : null; } catch (e) { return null; }
  }
  async function open() {
    if (status && now() - status.at < STATUS_TTL) return status.open;
    try {
      if (!statusUrl || !fetchImpl) return false;
      const resp = await fetchImpl(statusUrl, { method: 'GET' });
      const data = resp.ok ? await resp.json().catch(() => null) : null;
      status = { open: Boolean(data && data.open === true), at: now() };
      return status.open;
    } catch (e) { return false; }
  }

  async function shouldAsk() {
    if (askedThisPage || cards.length === 0) return false;
    if (storage && (await sget(SETTING_KEY, true)) === false) return false;
    const last = storage ? Number(await sget(LAST_ASKED_KEY, 0)) : 0;
    if (last && now() - last < GAP_MS) return false;
    if (!(await session())) return false;
    return open();
  }
  async function markAsked() {
    askedThisPage = true;
    if (storage) await sset({ [LAST_ASKED_KEY]: now() });
  }
  async function turnOff() { if (storage) await sset({ [SETTING_KEY]: false }); }

  // What triggered a card, as the server's closed list expects it. Nothing from the page itself.
  function triggerOf(card) {
    if (!card) return {};
    const i = cards.findIndex((c) => c.id === card.id); // the picker works on copies (list()), so match by id
    const prev = i > 0 ? cards[i - 1] : null;
    const basis = typeof card.basis === 'string' ? card.basis : null;
    return {
      cardType: card.type,
      ...(card.state ? { detectorState: card.state } : {}),
      ...(basis ? { detectorBasis: basis } : {}),
      ...(card.policyAction ? { policyAction: card.policyAction } : {}),
      ...(basis ? { baseline: basis.startsWith('personal') ? 'personal' : basis === 'generic' ? 'generic' : undefined } : {}),
      ...(prev ? { secondsSinceLastCard: Math.max(0, Math.round((card.at - prev.at) / 1000)) } : {}),
    };
  }

  // Sends one answer. Returns true when the server stored it.
  async function send(kind, answer, { card = null, situation = null, note = null } = {}) {
    try {
      const s = await session();
      if (!s || !postUrl || !fetchImpl) return false;
      const details = kind === 'wrong_moment' ? { ...triggerOf(card), ...(situation ? { situation } : {}) } : {};
      Object.keys(details).forEach((k) => details[k] === undefined && delete details[k]);
      const body = {
        surface, kind, answer, details,
        ...(note && String(note).trim() ? { note: String(note).trim().slice(0, 500) } : {}),
        ...(assignmentId ? { assignmentId } : {}),
        ...(assignmentId && card?.unitId ? { knowledgeUnitId: card.unitId } : {}),
      };
      const resp = await fetchImpl(postUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return resp.ok;
    } catch (e) { return false; }
  }

  return { noteCard, noteDetector, list, shouldAsk, markAsked, turnOff, send, triggerOf };
}
