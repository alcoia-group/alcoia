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

// ── Magic-link sign-in handoff (item S3) ────────────────────────────────
// The Phase 1 landing page (alcoiaWeb, a separate repo) verifies an emailed
// magic link, gets a short-lived one-time CODE from the server, and hands
// it to this extension via chrome.runtime.sendMessage(EXTENSION_ID,
// { code }). Only background.js can ever receive that —
// chrome.runtime.onMessageExternal does not fire in content scripts or
// extension pages at all, a Chrome platform fact, not a design choice.
//
// The exchange logic below mirrors src/shared/session.js's own,
// independently-tested exchangeCode() by hand — it cannot be imported here.
// See that file's own header for the full reasoning (this is a classic,
// non-`"type":"module"` service worker, and dynamic import() is disallowed
// in one regardless). tests/background-session.test.js exercises THIS copy
// directly, not just the one in session.js, since the two are not
// mechanically kept in sync.
//
// Two independent things stop a forged code from an arbitrary page:
//  1. manifests/base.json's `externally_connectable.matches` — Chrome
//     itself never delivers this event from a page that does not match.
//  2. The explicit sender.origin check below. This one is NOT a backstop
//     the way the AI-call rate limiter is (CLAUDE.md: "not a security
//     control... the check is removable in a minute") — it is a real,
//     independent gate: if the manifest entry is ever accidentally
//     widened (a stray wildcard, a forgotten dev value left in), this is
//     what still catches it, since Chrome's own enforcement and this
//     file's are two separate pieces of code that could each be wrong on
//     their own.
// ── LTI launch handoff (item S6/E4 follow-up) ───────────────────────────
// The same platform fact as the magic-link handoff above (background.js
// is the only place that can ever receive onMessageExternal at all) now
// serves a second web page too: whatever page a Canvas launch lands the
// student's browser on, once built (see src/shared/config.js's own
// LTI_READER_ORIGIN comment for why that page does not exist in any repo
// available here yet, and why its origin is nonetheless a real,
// server-confirmed value rather than an invention).
//
// A SEPARATE branch, not a widened version of the magic-link one above —
// checked, and its own origin verified, BEFORE that listener's unconditional
// origin/shape check runs, so a message can only ever be processed under
// the one origin it is actually confirmed to come from. Two shapes,
// copied verbatim from alcoiaServer's src/http/routes/lti.js (confirmed
// by reading it directly, not assumed):
//   disclosure not yet shown: { disclosureRequired: true, reportingMode,
//     classId, ackCode } -- no session exists yet. Stores the pending
//     record and opens join-class.html, the SAME disclosure screen the
//     native invite-accept flow already uses (item S6) -- not a second
//     one. The join/session cannot complete from here; only that page's
//     own completeJoin() (gated on disclosureRendered, unchanged by this
//     item) can turn ackCode into a real session, via
//     invites.js's acknowledgeLtiDisclosure().
//   disclosure already acknowledged on an earlier launch: { sessionToken,
//     kind: 'lti', classId, assignmentId, redirectTo } -- stores the
//     session directly, same as the magic-link exchange, and stops. No
//     UI of any kind here: the guarantee ("join must not complete until
//     disclosure has genuinely rendered") is already satisfied server-side
//     — this seat's disclosure_ack_at was set on a PRIOR launch that DID
//     go through the disclosure screen, not skipped.
function handleLtiLaunchMessage(payload, sendResponse) {
  if (!payload || typeof payload !== 'object') {
    sendResponse({ ok: false, error: 'malformed_payload' });
    return;
  }

  if (payload.disclosureRequired === true) {
    const ackCode = typeof payload.ackCode === 'string' ? payload.ackCode.trim() : '';
    const classId = typeof payload.classId === 'string' ? payload.classId : '';
    if (!ackCode || !classId) {
      sendResponse({ ok: false, error: 'malformed_payload' });
      return;
    }
    chrome.storage.local.set({
      sra_pending_lti_launch: {
        ackCode,
        classId,
        reportingMode: typeof payload.reportingMode === 'string' ? payload.reportingMode : null,
        at: Date.now(),
      },
    }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/join-class.html') });
      sendResponse({ ok: true, disclosureRequired: true });
    });
    return;
  }

  if (typeof payload.sessionToken === 'string' && payload.sessionToken
    && typeof payload.classId === 'string' && payload.classId) {
    const session = {
      token: payload.sessionToken,
      // No email is ever returned at this step (confirmed absent from
      // /api/lti/launch's own success shape, unlike the magic-link
      // exchange's) — empty string, not a fabricated placeholder, so any
      // page rendering it shows blank rather than the literal word "null".
      email: '',
      expiresAt: normaliseSessionExpiry(payload.expiresAt),
    };
    chrome.storage.local.set({
      [self.ALCOIA_CONFIG.SESSION_STORAGE_KEY]: session,
      // Same key, same shape join-class.js/upgrade.js already read for
      // display (item S6/S6-follow-up) — seatId/role are genuinely absent
      // from this response (see invites.js's own header on the one real
      // consequence: "Leave this class" cannot release a seat it has no
      // id for).
      sra_class_membership: { classId: payload.classId, seatId: null, role: null, joinedAt: Date.now() },
    }, () => {
      sendResponse({ ok: true, disclosureRequired: false });
    });
    return;
  }

  sendResponse({ ok: false, error: 'malformed_payload' });
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const ltiOrigin = self.ALCOIA_CONFIG.LTI_READER_ORIGIN;
  if (sender && sender.origin === ltiOrigin && msg && msg.type === 'ltiLaunch') {
    handleLtiLaunchMessage(msg.payload, sendResponse);
    return true;
  }

  const allowedOrigin = self.ALCOIA_CONFIG.WEB_APP_ORIGIN;
  if (!sender || sender.origin !== allowedOrigin) {
    sendResponse({ ok: false, error: 'origin_not_allowed' });
    return false;
  }

  const code = msg && typeof msg.code === 'string' ? msg.code.trim() : '';
  if (!code) {
    sendResponse({ ok: false, error: 'no_code' });
    return false;
  }

  const url = self.ALCOIA_CONFIG.EXTENSION_SESSION_EXCHANGE_URL;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
    .then(async (resp) => {
      if (!resp.ok) {
        // Expired, unknown, or already-consumed all collapse to the same
        // honest "rejected" outcome, reported once — never silently
        // retried. Mirrors session.js's exchangeCode() exactly.
        sendResponse({ ok: false, error: 'code_rejected', status: resp.status });
        return;
      }
      const data = await resp.json().catch(() => null);
      // CONFIRMED against alcoiaServer's real route handler (read-only
      // reference, that repo is not built here): src/http/routes/
      // extension-session.js, createExtensionSessionRouter's POST
      // /api/auth/extension-session/exchange success path —
      // `res.status(200).json({ sessionToken, email, kind: 'extension',
      // expiresAt: expiresAt.toISOString() })`. Mirrors session.js's own
      // exchangeCode() exactly, including its second correction: `email`
      // WAS confirmed absent from this response in an earlier pass; that
      // route now looks the account up server-side and includes it, so
      // this is restored to a required field here too, this time real.
      if (!data || typeof data.sessionToken !== 'string' || !data.sessionToken
        || typeof data.email !== 'string' || !data.email) {
        sendResponse({ ok: false, error: 'malformed_response' });
        return;
      }
      const session = { token: data.sessionToken, email: data.email, expiresAt: normaliseSessionExpiry(data.expiresAt) };
      chrome.storage.local.set({ [self.ALCOIA_CONFIG.SESSION_STORAGE_KEY]: session }, () => {
        sendResponse({ ok: true, email: session.email });
      });
    })
    .catch(() => {
      sendResponse({ ok: false, error: 'network_error' });
    });
  return true; // keep the message channel open for the async response
});

// Mirrors src/shared/session.js's own normaliseExpiry() — see this
// listener's own comment, and that file's header, for why this cannot just
// import it.
function normaliseSessionExpiry(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now() + 90 * 24 * 60 * 60 * 1000;
}

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
