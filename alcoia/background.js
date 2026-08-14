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
//
// Item 29: two escape hatches, both checked before redirecting.
//   1. sra_pdf_takeover in storage — the popup's "Open local PDF/PPTX files
//      in alcoia" toggle. Off means this listener never redirects anything;
//      every local PDF/PPTX opens in the browser's own viewer, unconditionally.
//   2. The #alcoia-open-native URL fragment — set by the viewer page's own
//      "Open in browser viewer" button (src/pdf-viewer/viewer.js,
//      src/pptx-viewer/viewer.js) when navigating BACK to the original
//      file:// URL for a document already open in alcoia's viewer. Without
//      this, that navigation would immediately be redirected right back to
//      the alcoia viewer it was trying to leave. The fragment survives
//      local file navigation (it has no effect on which file loads) and
//      needs no persisted state that could outlive a service-worker
//      restart, unlike an in-memory "ignore the next navigation" flag would.
//
// Item 31 extends the same listener to http(s) PDFs — opt-in and OFF by
// default (sra_web_pdf_takeover), a separate setting from the local-file
// toggle above. Four differences from the file:// case, each handled
// explicitly rather than assumed away:
//   - Detection is extension-only (the URL literally ends .pdf). A PDF
//     served from a URL with no .pdf-looking extension is not caught —
//     doing that properly means inspecting Content-Type via
//     declarativeNetRequest or webRequest, which needs a new permission
//     with its own Web Store review surface. Deliberately not added here;
//     this item ships the common case, not the general one.
//   - tabs.onUpdated only ever reports the TAB's own (top-level) URL —
//     it has no visibility into an iframe's internal navigation at all, so
//     an embedded PDF viewer inside an iframe structurally cannot trigger
//     this listener. No frame-filtering logic was needed to guarantee that;
//     it falls out of which API this already uses. Verified, not assumed —
//     see tests/browser/smoke.mjs's item 31 block.
//   - Authenticated PDFs: viewer.js's own fetch (via pdf.js) runs from the
//     extension page's origin, not the original site's, so a PDF gated
//     behind a session cookie can fail even though the reader's own
//     top-level navigation would have succeeded. viewer.js fails OPEN on
//     any http(s) load failure — it bounces the tab back to the original
//     URL with the same #alcoia-open-native bypass fragment the escape
//     hatch uses, landing the reader on Chrome's own handling of their
//     document rather than an alcoia error page. See viewer.js.
//   - Download/print: unaffected by this item — the escape hatch (item 29)
//     already hands a web PDF the same "open in browser viewer" path a
//     local one gets, and Chrome's own viewer covers both from there.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  const url = tab.url || '';
  if (!url) return;
  if (url.includes('#alcoia-open-native')) return;

  const isLocalPdf  = /^file:\/\/.+\.pdf(\?.*)?(#.*)?$/i.test(url);
  const isLocalPptx = /^file:\/\/.+\.pptx(\?.*)?(#.*)?$/i.test(url);
  const isWebPdf    = /^https?:\/\/.+\.pdf(\?.*)?(#.*)?$/i.test(url);
  if (!isLocalPdf && !isLocalPptx && !isWebPdf) return;

  chrome.storage.local.get({ sra_pdf_takeover: true, sra_web_pdf_takeover: false }, (res) => {
    if ((isLocalPdf || isLocalPptx) && res.sra_pdf_takeover === false) return; // escape hatch: local takeover disabled
    if (isWebPdf && !res.sra_web_pdf_takeover) return; // opt-in: off unless the reader turned it on
    const target = isLocalPptx ? 'src/pptx-viewer/viewer.html' : 'src/pdf-viewer/viewer.html';
    const viewerUrl = chrome.runtime.getURL(target) + '?src=' + encodeURIComponent(url);
    chrome.tabs.update(tabId, { url: viewerUrl });
  });
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
