/* config.js — the one place the backend origin is defined.
 *
 * Loaded as a plain classic script (not an ES module) into all three
 * contexts that used to hardcode this separately: the content script
 * (manifests/base.json content_scripts.js, listed before content.js),
 * the background service worker (background.js, via importScripts on
 * Chrome; manifests/firefox.json's background.scripts array on Firefox),
 * and the popup (popup.html, before popup.js). Every context shares a
 * `self` — window in the popup and content script, WorkerGlobalScope in
 * the Chrome service worker — so attaching to `self` reaches all three
 * without needing a module system any of them actually has.
 *
 * No production origin has been assigned yet. BACKEND_ORIGIN below is a
 * placeholder on the reserved `.invalid` TLD (RFC 2606) so it fails DNS
 * cleanly instead of silently resolving somewhere unintended — replace it
 * with the real deployed origin before any public release.
 *
 * A developer running a local backend does not need to edit this file or
 * the manifest: open the popup's Settings and set "Backend URL" (stored as
 * sra_backend_url), which overrides this default at runtime. See
 * README.md's "Running the Backend Server" section.
 *
 * Item S3 (magic-link sign-in) is the one exception to "no edit needed" —
 * WEB_APP_ORIGIN below feeds a runtime origin check in background.js, but
 * it also has to exactly match a SEPARATE, static value in
 * manifests/base.json's `externally_connectable.matches` (JSON, cannot
 * import this file, cannot be overridden at runtime the way Backend URL
 * can) — see build.mjs's own comment on that manifest entry for the full
 * reasoning. A developer testing sign-in locally against a differently-
 * ported alcoiaWeb needs to edit BOTH this constant AND that manifest
 * entry, by hand, together.
 */
(function (root) {
  const BACKEND_ORIGIN = 'http://localhost:3000';

  // *** DEV VALUE — NOT LIVE. *** alcoia.app does not resolve yet; this
  // whole roadmap is designed to work without it. The port is Vite's
  // default and a GUESS at what alcoiaWeb (the Phase 1 landing page, a
  // separate repo) actually runs on locally — confirm against that repo's
  // own dev server output. Swap to 'https://alcoia.app' (and
  // manifests/base.json's matching entry to 'https://alcoia.app/*')
  // before any real launch.
  const WEB_APP_ORIGIN = 'http://localhost:8080';

  root.ALCOIA_CONFIG = Object.freeze({
    BACKEND_ORIGIN: BACKEND_ORIGIN,
    SUMMARIZE_URL: BACKEND_ORIGIN + '/api/summarize',
    // Issues the opaque per-install token every AI call must carry. See
    // src/shared/install-token.js and CLAUDE.md's Access control section.
    TOKEN_URL: BACKEND_ORIGIN + '/api/token',
    // Item S3 — see src/shared/session.js and background.js's
    // onMessageExternal listener.
    WEB_APP_ORIGIN: WEB_APP_ORIGIN,
    // ASSUMED path — SERVER-ARCHITECTURE.md §4 does not name the
    // magic-link REQUEST endpoint, only the exchange one below. Modelled on
    // the existing /api/token, /api/summarize naming. Confirm against the
    // real alcoiaServer route before relying on it in production.
    MAGIC_LINK_REQUEST_URL: BACKEND_ORIGIN + '/api/auth/magic-link',
    // Named explicitly in SERVER-ARCHITECTURE.md §4: "POST
    // /api/auth/extension-session/exchange is the only thing that turns a
    // code into an actual extension session."
    EXTENSION_SESSION_EXCHANGE_URL: BACKEND_ORIGIN + '/api/auth/extension-session/exchange',
    // Mirrors src/shared/session.js's own STORAGE_KEY export — duplicated
    // here (not imported; see that file's header) so background.js, which
    // cannot import an ES module, still reads the same literal every other
    // context does. If you change one, change both.
    SESSION_STORAGE_KEY: 'sra_session',
    // Item E1 — src/shared/entitlements.js. Named explicitly in
    // SERVER-ARCHITECTURE.md §4: "GET /api/entitlements returns
    // { tier, features[], expires }."
    ENTITLEMENTS_URL: BACKEND_ORIGIN + '/api/entitlements',
    // Item E3 — src/shared/billing.js. Both confirmed by reading
    // alcoiaServer's src/http/routes/billing.js directly, not assumed:
    // POST here with { plan: 'reader' | 'student' } -> { checkout_url };
    // GET the portal one -> { portal_url }.
    BILLING_CHECKOUT_URL: BACKEND_ORIGIN + '/api/billing/checkout',
    BILLING_PORTAL_URL: BACKEND_ORIGIN + '/api/billing/portal',
    // Item S6 — src/shared/invites.js. Both confirmed by reading
    // alcoiaServer's src/http/routes/invites.js and seats.js directly:
    // POST invites/accept with { token } -> { classId, seatId, role };
    // POST seats/:id/release -> { released: true }. SEATS_URL is a base —
    // invites.js appends "/:id/release" itself.
    INVITE_ACCEPT_URL: BACKEND_ORIGIN + '/api/invites/accept',
    SEATS_URL: BACKEND_ORIGIN + '/api/seats',
    // LTI launch (item S6/E4 follow-up) — src/shared/invites.js's
    // acknowledgeLtiDisclosure(). Confirmed by reading alcoiaServer's
    // src/http/routes/lti.js directly: POST here with
    // { acknowledged: true, ackCode } -> { sessionToken, kind: 'lti',
    // classId, assignmentId, redirectTo }. No Authorization header — there
    // is no session yet at this point in the flow; a successful ack is
    // what MINTS one.
    LTI_DISCLOSURE_ACK_URL: BACKEND_ORIGIN + '/api/lti/disclosure/ack',
    // The web page a Canvas launch actually lands the student's browser
    // on (whatever receives /api/lti/launch's JSON and hands it to this
    // extension) does not exist in any repo available here yet — same gap
    // WEB_APP_ORIGIN above already accepted for item S3 ("alcoia.app does
    // not resolve yet; this whole roadmap is designed to work without
    // it"). This value is NOT invented: it is copied verbatim from
    // alcoiaServer's own default parameter for ltiReaderBaseUrl in
    // src/http/routes/lti.js (createLtiRouter's own `.invalid`
    // placeholder), so background.js's origin check matches what the
    // server itself already assumes that page's origin will be.
    LTI_READER_ORIGIN: 'https://console.alcoia.invalid',
    // Assignments entry point (S6/E4 follow-up) — src/shared/assignments.js
    // and src/content/host.js's outcome reporting. Both confirmed by
    // reading alcoiaServer's src/http/routes/assignments.js, documents.js
    // and outcomes.js directly:
    //   GET  /api/assignments/mine (NEW — no student-facing assignment
    //     listing existed anywhere before this item, confirmed by
    //     exhaustively grepping every registered route first) ->
    //     { assignments: [{ assignmentId, classId, className, closesAt,
    //     documents: [{ documentId, format, status }] }] }
    //   GET  /api/documents/:id/download-url -> { url, expiresInSeconds }
    //   POST /api/assignments/:id/outcomes { paragraph_index, struggled,
    //     question_id, correct, confidence, reached } -> { recorded: true }
    // DOCUMENTS_URL is a base — assignments.js appends "/:id/download-url"
    // itself; ASSIGNMENTS_URL is a base — host.js appends
    // "/:id/outcomes" itself.
    ASSIGNMENTS_MINE_URL: BACKEND_ORIGIN + '/api/assignments/mine',
    ASSIGNMENTS_URL: BACKEND_ORIGIN + '/api/assignments',
    DOCUMENTS_URL: BACKEND_ORIGIN + '/api/documents',
    // Item DC-1a — src/shared/kinematics.js and host.js's submitKinematics.
    // Confirmed by reading alcoiaServer's src/http/routes/scroll-sessions.js
    // directly: POST here with { assignmentId, kinematics, collectionLabel? }
    // -> { recorded: true }. Not nested under ASSIGNMENTS_URL like outcomes —
    // this is a flat route with assignmentId as a body field, not a path param.
    KINEMATICS_URL: BACKEND_ORIGIN + '/api/sessions/kinematics',
  });
})(typeof self !== 'undefined' ? self : this);
