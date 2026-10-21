/* reading-tab.js — finds the page a reader was last looking at, for buttons on
 * extension pages (the settings page opens in its own tab, so "the active tab"
 * is the settings page itself, which has no content script).
 *
 * Picks the most recently used ordinary web, file or viewer tab in the current
 * window and sends it the same message the popup's own buttons send
 * ({ action: 'sessionRecall' }, { action: 'showReceipt' }). Nothing is stored.
 */

const SKIP_PREFIXES = ['chrome-extension://', 'moz-extension://', 'chrome://', 'about:', 'edge://', 'devtools://'];

export function isReadingTab(tab) {
  const url = tab?.url;
  if (!tab || typeof tab.id !== 'number' || typeof url !== 'string' || !url) return false;
  return !SKIP_PREFIXES.some((p) => url.startsWith(p));
}

/* Newest first; a tab with no lastAccessed sorts last. */
export function pickReadingTab(tabs) {
  const usable = (tabs || []).filter(isReadingTab);
  usable.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return usable[0] || null;
}

/* Resolves { ok, reason?, response? }. Never rejects. */
export function sendToReadingTab(chromeApi, message) {
  return new Promise((resolve) => {
    try {
      chromeApi.tabs.query({ currentWindow: true }, (tabs) => {
        const tab = pickReadingTab(tabs);
        if (!tab) { resolve({ ok: false, reason: 'no_page' }); return; }
        chromeApi.tabs.sendMessage(tab.id, message, (response) => {
          if (chromeApi.runtime?.lastError) { resolve({ ok: false, reason: 'unreachable' }); return; }
          resolve({ ok: true, response, tabId: tab.id });
        });
      });
    } catch (e) {
      resolve({ ok: false, reason: 'unreachable' });
    }
  });
}
