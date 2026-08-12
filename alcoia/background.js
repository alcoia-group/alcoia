// background service worker (MV3)
// Handles messages from content scripts and popup (notes saving, AI proxy)

// Shared backend-origin config (src/shared/config.js). Chrome's MV3 service
// worker is a classic (non-module) worker, so it pulls the file in directly;
// Firefox's event page instead loads it as a preceding <script> via
// manifests/firefox.json's `background.scripts` array, which already runs
// in the same global scope — importScripts does not exist there.
if (typeof importScripts === 'function') importScripts('src/shared/config.js');

// ── Local PDF redirect ─────────────────────────────────────────────────────────
// Chrome's native PDF viewer runs in a sandboxed renderer that content scripts
// cannot inject into. When a local file:// PDF is opened, redirect it to the
// extension's custom PDF viewer page, which has full alcoia integration.
// Requires "Allow access to file URLs" to be enabled in chrome://extensions.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  const url = tab.url || '';
  if (!url) return;

  if (/^file:\/\/.+\.pdf(\?.*)?$/i.test(url)) {
    const viewerUrl = chrome.runtime.getURL('src/pdf-viewer/viewer.html') + '?src=' + encodeURIComponent(url);
    chrome.tabs.update(tabId, { url: viewerUrl });
    return;
  }

  if (/^file:\/\/.+\.pptx(\?.*)?$/i.test(url)) {
    const viewerUrl = chrome.runtime.getURL('src/pptx-viewer/viewer.html') + '?src=' + encodeURIComponent(url);
    chrome.tabs.update(tabId, { url: viewerUrl });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  if (msg.action === 'openTab') {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ status: 'ok' });
    return;
  }

  if (msg.action === 'saveNote') {
    chrome.storage.local.get({ sra_notes: [] }, (res) => {
      const notes = res.sra_notes || [];
      notes.unshift({ id: Date.now(), text: msg.note.text, meta: msg.note.meta || {} });
      chrome.storage.local.set({ sra_notes: notes }, () => {
        sendResponse({ status: 'ok' });
      });
    });
    return true;
  }

  if (msg.action === 'getNotes') {
    chrome.storage.local.get({ sra_notes: [] }, (res) => {
      sendResponse({ notes: res.sra_notes || [] });
    });
    return true;
  }

  // Proxy AI summary requests. Content scripts can't call the local server
  // directly — their fetch carries the host page's origin, which the server's
  // CORS policy rejects. Fetching from here (the extension's own context) sends
  // no page origin, so the server accepts it and stays locked to the extension.
  // Generic POST proxy. 'summarize' is kept as the original name; 'apiPost'
  // is the same path for any other endpoint (questions, and whatever comes
  // next). Both exist for the same reason: a content script's fetch carries
  // the host page's origin, which the server's CORS policy rejects.
  if (msg.action === 'summarize' || msg.action === 'apiPost') {
    const url = msg.url || self.ALCOIA_CONFIG.SUMMARIZE_URL;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body || {}),
    })
      .then(async (resp) => {
        if (!resp.ok) { sendResponse({ ok: false, status: resp.status }); return; }
        const data = await resp.json();
        sendResponse({ ok: true, data });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      });
    return true; // keep the message channel open for the async response
  }

  return false;
});
