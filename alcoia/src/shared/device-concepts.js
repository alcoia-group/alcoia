/* device-concepts.js — what this browser has learned about the reader's grasp of IDEAS on ordinary web pages
 * (arXiv papers, articles, documentation). Kept on the device only.
 *
 * Promises, all enforced by structure:
 *   - This module has no network code at all: it imports nothing and calls no fetch/XMLHttpRequest/sendMessage.
 *     Nothing about which pages were read or which ideas came up is sent to the server, to the account or to the
 *     evidence pool, and it is not synced across devices.
 *   - A page URL, title or any passage is never stored. Only a short idea label (at most 60 characters) and five
 *     counts per idea are kept, capped at MAX_CONCEPTS (the least recently used are dropped).
 *   - It is cleared in one click from the diagnostics page and removed with the extension's data.
 *
 * How ideas are found, with no model and no upload: terms are picked from the paragraph by plain rules (a term the
 * text itself defines or names, an acronym, or a short run of content words). A term only counts as an idea once it
 * has appeared in at least MIN_PARAGRAPHS different paragraphs of the page being read, so one-off phrases are ignored.
 * This is a coarse heuristic and will miss ideas and sometimes pick a phrase that is not one.
 *
 * What it changes: only the local decision about whether to ask or explain, through the same estimate shape the
 * server's estimate uses. A reader who has answered an idea correctly several times, with no misses, is asked less
 * about it; one who has missed it more than once and more often than not gets an explanation instead of another
 * question. It only narrows what the reading signals already proposed. Thresholds are provisional.
 */

const STORAGE_KEY = 'sra_device_concepts';
export const MAX_CONCEPTS = 400;
export const MIN_PARAGRAPHS = 3;
const MAX_LABEL = 60;
const MAX_TERMS_PER_PARAGRAPH = 12;
const MAX_SEEN_TERMS = 3000;

const STOP = new Set(('a about above after again all also although am an and any are as at be because been before being below between both but by can could did do does doing down during each either few for from further had has have having he her here hers him his how however i if in into is it its itself just may me might more most must my no nor not of off on once only or other our ours out over own same she should since so some such than that the their theirs them then there these they this those through thus to too under until up upon us very was we were what when where whether which while who whom why will with within without would you your ' +
  'show shown shows paper results result method methods using used use based approach work present propose proposed section figure table et al etc however therefore moreover given let note obtain obtained several many one two three first second new well previous recent previously consider following case cases').split(/\s+/));

export const termKey = (label) => String(label ?? '').toLowerCase().replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim();

// Pure: candidate idea labels in one paragraph, most specific first.
export function extractTerms(text) {
  const t = String(text ?? '').slice(0, 4000);
  const out = new Map();
  const add = (label) => {
    const clean = String(label).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
    const key = termKey(clean);
    if (key.length < 3 || out.has(key)) return;
    out.set(key, clean);
  };
  // Terms the text itself defines or names.
  for (const m of t.matchAll(/\b(?:called|known as|termed|referred to as|denoted)\s+(?:the\s+)?[“"']?([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,2})/g)) add(m[1]);
  for (const m of t.matchAll(/\b(?:we|to)\s+define\s+(?:the\s+)?[“"']?([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,2})/g)) add(m[1]);
  // Acronyms.
  for (const m of t.matchAll(/\b([A-Z][A-Z0-9]{1,5})\b/g)) add(m[1]);
  // Runs of two or three content words.
  const words = t.match(/[A-Za-z][A-Za-z-]{2,}/g) ?? [];
  for (let n = 3; n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n);
      if (run.some((w) => STOP.has(w.toLowerCase()))) continue;
      add(run.join(' '));
    }
  }
  return [...out.entries()].slice(0, MAX_TERMS_PER_PARAGRAPH * 4).map(([key, label]) => ({ key, label }));
}

// Pure: what the counts for one idea say.
export function estimateFromCounts(row) {
  const ok = row?.ok ?? 0;
  const bad = row?.bad ?? 0;
  if (bad >= 2 && bad > ok) return 'needs_help';
  if (ok >= 3 && bad === 0) return 'secure';
  return 'unknown';
}

// Pure: the policy-shaped estimate for a paragraph's ideas, or null when the counts say nothing.
export function paragraphEstimate(rows) {
  const levels = rows.map(estimateFromCounts);
  if (levels.includes('needs_help')) {
    return { level: 'needs_help', confidence: 'low', action: 'intervene', kind: 'explain', reason: 'device_concept_needs_help' };
  }
  if (levels.length && levels.every((l) => l === 'secure')) {
    return { level: 'secure', confidence: 'low', action: 'abstain', reason: 'device_concept_secure' };
  }
  return null;
}

export function createDeviceConcepts(opts = {}) {
  const storage = opts.storage || (typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null);
  const now = opts.now || (() => Date.now());
  const maxConcepts = opts.maxConcepts ?? MAX_CONCEPTS;
  const minParagraphs = opts.minParagraphs ?? MIN_PARAGRAPHS;
  const get = (keys) => new Promise((resolve) => storage.get(keys, resolve));
  const set = (obj) => new Promise((resolve) => storage.set(obj, () => resolve()));

  // This page, this load only: term key -> Set(paragraph ids). Never stored. paragraph id -> qualified term keys.
  const seen = new Map();
  const paragraphTerms = new Map();
  let cache = null; // key -> row, mirrored from storage
  let chain = Promise.resolve();

  async function load() {
    if (cache) return cache;
    if (!storage) return (cache = {});
    try { cache = (await get({ [STORAGE_KEY]: {} }))[STORAGE_KEY] || {}; } catch (e) { cache = {}; }
    return cache;
  }
  function persist() {
    if (!storage) return chain;
    chain = chain.then(async () => {
      try {
        const keys = Object.keys(cache);
        if (keys.length > maxConcepts) {
          keys.sort((a, b) => (cache[a].last ?? 0) - (cache[b].last ?? 0));
          for (const k of keys.slice(0, keys.length - maxConcepts)) delete cache[k];
        }
        await set({ [STORAGE_KEY]: cache });
      } catch (e) { /* never a new failure on a reading path */ }
    });
    return chain;
  }

  /* A paragraph was read. Returns the keys of its qualified ideas (those seen in enough paragraphs of this page). */
  async function noteRead(paragraphId, text) {
    if (!paragraphId) return [];
    await load();
    const terms = extractTerms(text);
    const labels = new Map(terms.map((t) => [t.key, t.label]));
    for (const { key } of terms) {
      let set_ = seen.get(key);
      if (!set_) {
        if (seen.size >= MAX_SEEN_TERMS) continue;
        set_ = new Set();
        seen.set(key, set_);
      }
      set_.add(paragraphId);
    }
    const qualified = terms.filter(({ key }) => (seen.get(key)?.size ?? 0) >= minParagraphs).slice(0, MAX_TERMS_PER_PARAGRAPH);
    paragraphTerms.set(paragraphId, qualified.map((t) => t.key));
    if (paragraphTerms.size > 500) paragraphTerms.delete(paragraphTerms.keys().next().value);
    for (const { key, label } of qualified) {
      const row = cache[key] ?? { label, enc: 0, ok: 0, bad: 0, explained: 0, last: 0 };
      row.label = label;
      row.last = now();
      cache[key] = row;
    }
    if (qualified.length) persist();
    return qualified.map((t) => t.key);
  }

  /* An answer to a question about this paragraph. correct: true | false | null (null counts for nothing). */
  async function noteAnswer(paragraphId, correct) {
    await load();
    if (typeof correct !== 'boolean') return;
    for (const key of paragraphTerms.get(paragraphId) ?? []) {
      const row = cache[key];
      if (!row) continue;
      row.enc += 1;
      if (correct) row.ok += 1; else row.bad += 1;
      row.last = now();
    }
    persist();
  }

  /* The estimate for a paragraph (synchronous; uses what is already loaded). */
  function estimateFor(paragraphId) {
    if (!cache) return null;
    const rows = (paragraphTerms.get(paragraphId) ?? []).map((k) => cache[k]).filter(Boolean);
    return rows.length ? paragraphEstimate(rows) : null;
  }

  /* The ideas that have qualified on THIS page load so far, as { key, label }. Read from memory only; nothing is
   * stored or sent. Used to match the page against the reader's own documents on this device. */
  function pageIdeas() {
    const out = [];
    for (const [key, ids] of seen) {
      if (ids.size < minParagraphs) continue;
      out.push({ key, label: cache?.[key]?.label ?? key });
    }
    return out;
  }

  /* What is kept, for the diagnostics page: labels and counts only. */
  async function list() {
    await load();
    return Object.entries(cache).map(([key, r]) => ({ key, ...r })).sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  }
  async function clear() {
    cache = {};
    seen.clear();
    paragraphTerms.clear();
    if (!storage) return;
    chain = chain.then(() => new Promise((resolve) => storage.remove(STORAGE_KEY, () => resolve())));
    await chain;
  }

  return { noteRead, noteAnswer, estimateFor, pageIdeas, list, clear, load };
}
