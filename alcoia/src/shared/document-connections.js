/* document-connections.js — "Connects to <your document>" on any web page.
 *
 * For a signed-in reader with the cross-document intelligence capability (Reader and Student plans, and seats that
 * include them). The account's workspace documents each have a short list of ideas. When the ideas this browser
 * detects on the page being read match one of those labels, the reading map gets a quiet entry that links to the
 * document in the workspace.
 *
 * What leaves the device: one request that is already part of the product, GET /api/account/document-concepts,
 * with the session token and nothing else. No URL, no page text, no detected idea is ever sent. The matching is
 * done here, in this file, on the device.
 *
 * What is kept on the device: a copy of that response (document titles, workspace paths and idea labels) for
 * CACHE_TTL_MS, under one storage key, so every page does not ask again. It belongs to the session's account and is
 * dropped when it is stale or the account has changed. Nothing about which pages matched is stored, and nothing is
 * written to learner memory: this module has no code path to the learner-memory routes.
 *
 * It never interrupts. It returns a list; the caller decides how to show it (a quiet reading-map entry and a badge).
 */

export const CACHE_KEY = 'sra_doc_concepts_cache';
export const CACHE_TTL_MS = 10 * 60 * 1000;
export const MAX_CONNECTIONS = 3;
const MAX_DOCUMENTS = 200;
const MAX_CONCEPTS_PER_DOCUMENT = 120;
const MAX_TITLE = 120;
const MAX_LABEL = 80;
const CAPABILITY = 'cross_document_intelligence';

/* Lower case, letters and digits only, one space between words. */
export function normaliseLabel(label) {
  return String(label ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/* Folds a plural to its singular so "neural networks" matches "neural network". Plain rules, English only; other
 * languages match when the words are spelled the same. */
export function foldPlural(word) {
  if (word.length <= 3) return word;
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function labelWords(label) {
  const n = normaliseLabel(label);
  return n ? n.split(' ').map(foldPlural) : [];
}

function isAcronym(label) {
  return /^[A-Z][A-Z0-9]{1,5}$/.test(String(label ?? '').trim());
}

/* A label is specific enough to match on its own: more than one word, or one word of 4 or more letters, or an
 * acronym. A bare "it" or "of" never matches. */
function isMatchable(label, words) {
  if (!words.length) return false;
  if (words.length > 1) return true;
  return words[0].length >= 4 || isAcronym(label);
}

function containsRun(haystack, needle) {
  if (needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/* pageIdeas: [{ key, label }] as detected on this page. documents: the server's list. Returns at most `max`
 * connections, one per document (its longest matching idea), longest matches first. A page idea matches a document
 * idea when the document idea's words appear, in order and side by side, in the page idea ("stochastic gradient
 * descent" matches "gradient descent"); the reverse does not. Pure. */
export function matchConnections(pageIdeas, documents, opts = {}) {
  const max = opts.max ?? MAX_CONNECTIONS;
  const workspaceOrigin = opts.workspaceOrigin || '';
  const ideas = (Array.isArray(pageIdeas) ? pageIdeas : [])
    .map((i) => ({ label: String(i?.label ?? i?.key ?? ''), words: labelWords(i?.label ?? i?.key) }))
    .filter((i) => i.words.length);
  if (!ideas.length || !Array.isArray(documents)) return [];

  const found = [];
  for (const doc of documents) {
    if (!doc || typeof doc.url_path !== 'string' || !doc.url_path.startsWith('/') || doc.url_path.startsWith('//')) continue;
    let best = null;
    for (const concept of Array.isArray(doc.concepts) ? doc.concepts : []) {
      const words = labelWords(concept?.label);
      if (!isMatchable(concept?.label, words)) continue;
      for (const idea of ideas) {
        if (!containsRun(idea.words, words)) continue;
        const score = words.length * 1000 + words.join(' ').length;
        if (!best || score > best.score) best = { score, concept: String(concept.label), idea: idea.label };
      }
    }
    if (best) {
      found.push({
        documentId: String(doc.id ?? ''),
        kind: doc.kind === 'personal' ? 'personal' : 'assignment',
        title: String(doc.title ?? '').slice(0, MAX_TITLE) || 'Untitled',
        href: `${workspaceOrigin}${doc.url_path}`,
        label: best.concept,
        idea: best.idea,
        score: best.score,
      });
    }
  }
  found.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return found.slice(0, max).map((f) => ({ documentId: f.documentId, kind: f.kind, title: f.title, href: f.href, label: f.label, idea: f.idea }));
}

/* Keeps only the fields used, with lengths capped, so a malformed or oversized response cannot grow what is stored. */
export function cleanDocuments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw.slice(0, MAX_DOCUMENTS)) {
    if (!d || typeof d.url_path !== 'string' || !d.url_path.startsWith('/')) continue;
    const concepts = (Array.isArray(d.concepts) ? d.concepts : [])
      .filter((c) => c && typeof c.label === 'string' && c.label.trim())
      .slice(0, MAX_CONCEPTS_PER_DOCUMENT)
      .map((c) => ({ label: c.label.trim().slice(0, MAX_LABEL) }));
    if (!concepts.length) continue;
    out.push({
      kind: d.kind === 'personal' ? 'personal' : 'assignment',
      id: String(d.id ?? '').slice(0, 64),
      title: String(d.title ?? '').slice(0, MAX_TITLE),
      url_path: d.url_path.slice(0, 200),
      concepts,
    });
  }
  return out;
}

export function createDocumentConnections(opts = {}) {
  const getSession = opts.getSession;
  const hasFeature = opts.hasFeature;       // async (name) => boolean
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const url = opts.url;
  const storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  const now = opts.now || (() => Date.now());
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const workspaceOrigin = opts.workspaceOrigin || '';

  let memory = null; // { at, owner, documents }

  const read = () => new Promise((resolve) => {
    if (!storage) { resolve(null); return; }
    try { storage.get({ [CACHE_KEY]: null }, (r) => resolve(r?.[CACHE_KEY] ?? null)); } catch (e) { resolve(null); }
  });
  const write = (value) => new Promise((resolve) => {
    if (!storage) { resolve(); return; }
    try { storage.set({ [CACHE_KEY]: value }, () => resolve()); } catch (e) { resolve(); }
  });
  const drop = () => new Promise((resolve) => {
    memory = null;
    if (!storage) { resolve(); return; }
    try { storage.remove(CACHE_KEY, () => resolve()); } catch (e) { resolve(); }
  });

  /* The account's document idea lists, from the short-lived copy when it is fresh. [] for anyone not entitled. */
  async function getDocuments() {
    let session = null;
    try { session = await getSession(); } catch (e) { session = null; }
    if (!session || typeof session.token !== 'string' || !session.token) { await drop(); return []; }
    const owner = String(session.email || session.token.slice(0, 12));

    const cached = memory || await read();
    if (cached && cached.owner === owner && now() - cached.at < ttlMs) { memory = cached; return cached.documents; }
    if (cached && (cached.owner !== owner || now() - cached.at >= ttlMs)) await drop();

    try { if (!(await hasFeature(CAPABILITY))) return []; } catch (e) { return []; }
    if (!url || !fetchImpl) return [];
    try {
      const resp = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${session.token}` } });
      if (!resp || !resp.ok) return [];
      const data = await resp.json().catch(() => null);
      const documents = cleanDocuments(data && data.documents);
      memory = { at: now(), owner, documents };
      await write(memory);
      return documents;
    } catch (e) {
      return [];
    }
  }

  /* pageIdeas: [{ key, label }] from the device-only idea detector. Never throws. */
  async function find(pageIdeas) {
    try {
      const documents = await getDocuments();
      if (!documents.length) return [];
      return matchConnections(pageIdeas, documents, { workspaceOrigin });
    } catch (e) {
      return [];
    }
  }

  return { find, getDocuments, clear: drop };
}
