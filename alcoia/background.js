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

// ── SPA route-change detection (item 27) ────────────────────────────────
// content.js's own history.pushState/replaceState monkey-patch runs in the
// content script's ISOLATED world and never reaches the page's own
// MAIN-world `history` object — confirmed by reading
// `history.pushState.toString()` from the page's own context after the
// patch runs; it still reports `[native code]`. A real single-page app's
// route changes call pushState from the page's own script, which that
// isolated-world patch can never see, so onSpaNavigate() effectively never
// ran except on a genuine popstate (back/forward button).
//
// webNavigation.onHistoryStateUpdated fires from the browser itself,
// independent of which JS world the history-API call originated in, so it
// needs no page-context injection at all — no MAIN-world script, no bridge,
// none of the machinery the gaze-removal item deleted for exactly that
// reason. The permission was already declared in manifests/base.json
// (previously unused — the README documented it as backing this file's
// file:// redirect, but that redirect is actually built on tabs.onUpdated;
// verified, not assumed, before relying on it here). No new permission was
// added for this.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return; // top frame only — content scripts run there only too
  chrome.tabs.sendMessage(details.tabId, { type: 'spaRouteChanged', url: details.url }, () => {
    // No content script listening on this tab (e.g. a chrome:// page, or the
    // extension's own pages) — nothing to do, and nothing to surface as an
    // error either.
    void chrome.runtime.lastError;
  });
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
  //
  // The install token (src/shared/install-token.js) is acquired by content.js,
  // not here, and arrives as `msg.token`. That split is a platform constraint,
  // not a design preference: install-token.js is a real ES module loaded via
  // dynamic import(), and Chrome disallows dynamic import() from inside a
  // service worker entirely ("import() is disallowed on
  // ServiceWorkerGlobalScope by the HTML specification") — confirmed the hard
  // way, via the browser smoke test, not assumed. Content scripts have no
  // such restriction, so the token lives there; this worker stays a dumb
  // relay that requires one to already be present. No token, no request.
  if (msg.action === 'summarize' || msg.action === 'apiPost') {
    const url = msg.url || self.ALCOIA_CONFIG.SUMMARIZE_URL;
    if (!msg.token) { sendResponse({ ok: false, error: 'no_install_token' }); return; }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Alcoia-Install-Token': msg.token },
      body: JSON.stringify(msg.body || {}),
    })
      .then(async (resp) => {
        // The server validated the token itself and said no — expired,
        // revoked, or never valid. Flagged distinctly so content.js's
        // install-token manager can clear its stored copy and fetch a
        // fresh one on the next call, the same self-heal a reader
        // deleting it by hand would get.
        if (resp.status === 401 || resp.status === 403) {
          sendResponse({ ok: false, status: resp.status, tokenRejected: true });
          return;
        }
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
