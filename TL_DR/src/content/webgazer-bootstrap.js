// webgazer-bootstrap.js — Runs in PAGE context (not extension isolated world)
// IMPORTANT: Cannot use chrome.runtime here. URL is passed via data attribute.
(() => {
  if (window.__sra_webgazer_bootstrap_loaded) return;
  window.__sra_webgazer_bootstrap_loaded = true;

  // content.js sets data-webgazer-url on this <script> element before injecting it.
  // We read it via document.currentScript (valid during synchronous IIFE execution).
  const scriptEl = document.currentScript;
  const wgUrl = scriptEl && scriptEl.dataset && scriptEl.dataset.webgazerUrl;

  if (!wgUrl) {
    console.warn('[TL;DR] webgazer-bootstrap: missing data-webgazer-url attribute.');
    return;
  }

  const s = document.createElement('script');
  s.src = wgUrl;

  s.onload = function () {
    if (typeof webgazer === 'undefined') {
      console.warn('[TL;DR] webgazer loaded but not defined on window.');
      return;
    }
    try {
      webgazer
        .setRegression('ridge')
        .setGazeListener(function (d) {
          try { window.postMessage({ source: 'sra-webgazer', gaze: d }, '*'); } catch (e) {}
        })
        .begin();

      // Hide all built-in UI by default (debug mode can re-enable via popup toggle)
      try { webgazer.showPredictionPoints(false); } catch (e) {}
      try { webgazer.showVideo(false); } catch (e) {}
      try { webgazer.showFaceOverlay(false); } catch (e) {}
      try { webgazer.showFaceFeedbackBox(false); } catch (e) {}

      window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
    } catch (e) {
      console.warn('[TL;DR] webgazer init error:', e);
    }
  };

  s.onerror = function () {
    console.warn('[TL;DR] Failed to load webgazer bundle from:', wgUrl);
  };

  // Forward debug toggle from content script
  window.addEventListener('message', function (ev) {
    try {
      if (
        ev.source === window && ev.data &&
        ev.data.source === 'sra-control' &&
        ev.data.type === 'setPredictionPoints' &&
        typeof webgazer !== 'undefined'
      ) {
        webgazer.showPredictionPoints(!!ev.data.enabled);
      }
    } catch (e) {}
  }, false);

  (document.head || document.documentElement).appendChild(s);
})();