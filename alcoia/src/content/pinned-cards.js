// Pinned cards, remembered on this device so they come back at the next read of the same document, the way a document
// comes back to the page you were on. Nothing here leaves the device: it is chrome.storage.local (in the workspace, the
// same call backed by the browser's own storage), keyed by the page, never sent anywhere.
//
// An entry is what is needed to draw the card again: where it was, and either a static copy of its body or, for a
// question nobody has answered yet, the question itself so it can be answered after the restore. A card that is closed
// is removed, so only cards the reader chose to keep come back.

const STORAGE_KEY = 'sra_pinned_cards';
export const MAX_PER_PAGE = 6;
export const MAX_PAGES = 40;

// One page = the document, not the scroll position or the link fragment.
export function pageKeyFor(loc = globalThis.location) {
  try { return `${loc.origin}${loc.pathname}`; } catch (e) { return ''; }
}

export function createPinnedStore({ storage, pageKey = pageKeyFor(), now = () => Date.now() } = {}) {
  const area = storage ?? globalThis.chrome?.storage?.local ?? null;

  const readAll = () => new Promise((resolve) => {
    if (!area) return resolve({});
    try { area.get({ [STORAGE_KEY]: {} }, (r) => resolve((r && r[STORAGE_KEY] && typeof r[STORAGE_KEY] === 'object') ? r[STORAGE_KEY] : {})); }
    catch (e) { resolve({}); }
  });
  const writeAll = (all) => new Promise((resolve) => {
    if (!area) return resolve();
    try { area.set({ [STORAGE_KEY]: all }, () => resolve()); } catch (e) { resolve(); }
  });

  // Writes are serialised so two quick changes (a drag end and a close) never overwrite each other.
  let chain = Promise.resolve();
  const update = (fn) => { chain = chain.then(async () => { const all = await readAll(); fn(all); await writeAll(all); }).catch(() => {}); return chain; };

  return {
    pageKey,
    async load() {
      const all = await readAll();
      const list = Array.isArray(all[pageKey]) ? all[pageKey] : [];
      return list.filter((e) => e && typeof e.id === 'string' && typeof e.kind === 'string');
    },
    save(entry) {
      if (!entry || typeof entry.id !== 'string') return Promise.resolve();
      return update((all) => {
        const list = (Array.isArray(all[pageKey]) ? all[pageKey] : []).filter((e) => e.id !== entry.id);
        list.push({ ...entry, savedAt: now() });
        all[pageKey] = list.slice(-MAX_PER_PAGE);
        const keys = Object.keys(all);
        if (keys.length > MAX_PAGES) {
          const newest = (k) => Math.max(0, ...((all[k] || []).map((e) => e.savedAt || 0)));
          keys.sort((a, b) => newest(a) - newest(b));
          for (const k of keys.slice(0, keys.length - MAX_PAGES)) delete all[k];
        }
      });
    },
    remove(id) {
      return update((all) => {
        const list = (Array.isArray(all[pageKey]) ? all[pageKey] : []).filter((e) => e.id !== id);
        if (list.length) all[pageKey] = list; else delete all[pageKey];
      });
    },
  };
}
