/* shadow-host.js — Shadow DOM isolation for every element alcoia injects
 * into the host page.
 *
 * On some pages, the extension's injected UI rendered at the wrong size or
 * misaligned — the root cause was the host page's own CSS (resets like
 * `* { font-size: 32px }`, aggressive `button`/`div` defaults, `all: unset`
 * cascades) reaching straight into elements that, until now, all lived in
 * the page's own light DOM. Every alcoia-rendered element gets its own
 * shadow host here: `all: initial` clears whatever the page's cascade would
 * otherwise hand it, and the extension's own CSS is inlined into the shadow
 * root so nothing rendered inside depends on light-DOM stylesheets a page
 * could still interfere with.
 *
 * mode: 'open', not 'closed' — CSS isolation from the host page is
 * identical either way; only JS's ability to reach shadowRoot from outside
 * differs. This repo's own verification practice (CLAUDE.md: "a green run
 * is not evidence a feature works — verify in a browser") depends on
 * tests/browser/smoke.mjs being able to inspect rendered UI via
 * element.shadowRoot from Playwright's page.evaluate(); 'closed' would make
 * that return null everywhere and silently break that entire suite.
 *
 * The light-DOM <link data-sra-font>/<link data-sra-css> tags content.js
 * still injects into document.head are NOT redundant with this module: they
 * are what keeps the :root { --alc-*: ... } design tokens and @font-face
 * registrations live at the document level, which is what dark mode's
 * :root custom-property swap and every shadow root's inherited fonts both
 * still depend on. This module inlines the same stylesheets into each
 * shadow root ADDITIONALLY, for the selector-based rules (.sra-popup,
 * .sra-q-option, etc.) that a light-DOM stylesheet can no longer reach once
 * the elements they style live inside a shadow tree.
 */

let cachedStylesPromise = null;

/* fonts.css's @font-face src: url(...) values are relative to that file's
 * own location — fine when the browser loads it via a <link href="...">,
 * fatal once its text is copied into a shadow root's inline <style>, where
 * a relative URL resolves against the HOST PAGE's own URL instead and every
 * custom font silently fails to load. Rewritten to absolute
 * chrome-extension://<id>/... URLs here, once, rather than per shadow root. */
function absolutizeUrls(cssText, baseUrl) {
  return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote, url) => {
    if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:')) return match;
    return `url(${quote}${new URL(url, baseUrl).href}${quote})`;
  });
}

/* Fetched once per page load (module-level cache) — every shadow host after
 * the first reuses the same string instead of re-fetching two files per
 * popup. boot() awaits this once, before anything can render, so
 * createShadowHost() itself stays synchronous. */
async function loadSharedStyles() {
  if (!cachedStylesPromise) {
    cachedStylesPromise = (async () => {
      const fontsUrl   = chrome.runtime.getURL('src/styles/fonts.css');
      const overlayUrl = chrome.runtime.getURL('src/styles/overlay.css');
      const [fontsCss, overlayCss] = await Promise.all([
        fetch(fontsUrl).then((r) => r.text()),
        fetch(overlayUrl).then((r) => r.text()),
      ]);
      return absolutizeUrls(fontsCss, fontsUrl) + '\n' + overlayCss;
    })();
  }
  return cachedStylesPromise;
}

/* True while the reader has dark mode on. A shadow host created AFTER the
 * toggle reads this at creation time so it starts dark without every call
 * site needing to know about dark mode; setDarkMode() (called from
 * ui-controller.js's applyDarkMode()) is the only writer, and it also flips
 * every host that already exists. */
let darkModeOn = false;

/* One shared shadow host per call — mirrors the element it replaces
 * exactly on one axis the task's own naive pattern does not preserve on its
 * own: z-index. Every alcoia element had a deliberate stacking order
 * relative to every other one (.sra-popup highest, reading-map's tab/
 * sidebar lowest, etc. — see each call site) baked into its own rule in
 * overlay.css or an inline style. Giving every host the same z-index would
 * make relative stacking fall back to DOM append order instead, which is a
 * real behaviour change the task's "do not change any other behaviour"
 * instruction rules out — so the caller passes its element's own original
 * z-index through, rather than this module choosing one value for all. */
function createShadowHost(sharedStyles, zIndex) {
  const host = document.createElement('div');
  host.setAttribute('data-alcoia-host', 'true');
  host.style.cssText = `all: initial; position: fixed; z-index: ${zIndex};`;
  if (darkModeOn) host.setAttribute('data-sra-dark', 'true');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = sharedStyles;
  shadow.appendChild(style);

  document.body.appendChild(host);
  return { host, shadow };
}

function setDarkMode(enabled) {
  darkModeOn = enabled;
  for (const host of document.querySelectorAll('[data-alcoia-host]')) {
    host.toggleAttribute('data-sra-dark', enabled);
  }
}

/* Master-switch hard-off teardown (and any other full-cleanup path) removes
 * every shadow host in one call rather than needing to know every element
 * this module has ever created. */
function removeAllShadowHosts() {
  document.querySelectorAll('[data-alcoia-host]').forEach((host) => host.remove());
}

export { loadSharedStyles, createShadowHost, setDarkMode, removeAllShadowHosts };
