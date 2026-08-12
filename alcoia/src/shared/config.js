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
 */
(function (root) {
  const BACKEND_ORIGIN = 'https://api.alcoia.invalid';

  root.ALCOIA_CONFIG = Object.freeze({
    BACKEND_ORIGIN: BACKEND_ORIGIN,
    SUMMARIZE_URL: BACKEND_ORIGIN + '/api/summarize',
  });
})(typeof self !== 'undefined' ? self : this);
