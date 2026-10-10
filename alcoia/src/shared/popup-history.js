/* popup-history.js -- an optional, local-only list of the popups alcoia showed (explanations,
 * questions, summaries), so a reader can find one again after it closed.
 *
 * Kept on this device in chrome.storage.local and nowhere else: never sent to the server, not
 * synced, lost on uninstall or on another device. Deliberately small: a fixed number of entries,
 * each trimmed, so the whole list stays in the tens of kilobytes. Turning it off stops recording
 * and clears what is kept, which frees the space at once.
 *
 * Stored per entry: time, the site's host name (not the full address), a kind, and the popup's
 * text trimmed to a few hundred characters. It never stores what the reader typed into an answer
 * box after the popup opened, and nothing about the reader's account. */

export const HISTORY_KEY = 'sra_popup_history';
export const ENABLED_KEY = 'sra_popup_history_enabled';
export const MAX_ENTRIES = 30;
export const MAX_TEXT = 500;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function makeEntry({ text, host, kind, now = Date.now() }) {
  const t = clean(text);
  if (!t) return null;
  return { t: now, host: clean(host).slice(0, 100), kind: kind === 'question' ? 'question' : 'note', text: t.slice(0, MAX_TEXT) };
}

/* Newest first, capped; an identical entry that is already the newest is not repeated. */
export function addEntry(list, entry) {
  const cur = Array.isArray(list) ? list : [];
  if (!entry) return cur;
  if (cur[0] && cur[0].text === entry.text && cur[0].host === entry.host) return cur;
  return [entry, ...cur].slice(0, MAX_ENTRIES);
}

const store = () => (typeof chrome !== 'undefined' ? chrome.storage?.local : null);

export function isEnabled() {
  return new Promise((resolve) => {
    const s = store();
    if (!s) return resolve(false);
    s.get({ [ENABLED_KEY]: true }, (r) => resolve(r[ENABLED_KEY] !== false));
  });
}

export async function record(raw) {
  try {
    const s = store();
    if (!s || !(await isEnabled())) return;
    const entry = makeEntry(raw);
    if (!entry) return;
    s.get({ [HISTORY_KEY]: [] }, (r) => {
      s.set({ [HISTORY_KEY]: addEntry(r[HISTORY_KEY], entry) });
    });
  } catch { /* history is a convenience; never break the popup */ }
}

export function list() {
  return new Promise((resolve) => {
    const s = store();
    if (!s) return resolve([]);
    s.get({ [HISTORY_KEY]: [] }, (r) => resolve(Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : []));
  });
}

export function clear() {
  return new Promise((resolve) => {
    const s = store();
    if (!s) return resolve();
    s.remove(HISTORY_KEY, () => resolve());
  });
}

export async function setEnabled(on) {
  const s = store();
  if (!s) return;
  await new Promise((resolve) => s.set({ [ENABLED_KEY]: !!on }, resolve));
  if (!on) await clear(); // off frees the space
}
