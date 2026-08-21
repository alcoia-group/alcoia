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
  const BACKEND_ORIGIN = 'https://api.alcoia.invalid';

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
    // src/shared/install-token.js and the project notes' Access control section.
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
  });
})(typeof self !== 'undefined' ? self : this);
