// webgazer-bootstrap.js — Runs in PAGE context (not extension isolated world)
// Receives webgazer bundle URL via data-webgazer-url attribute (CSP-safe, no inline JS)
// Tries clmtrackr first (bundled, no external model downloads)
// Falls back to default tracker if unavailable
// Only fires cameraReady after .begin() resolves — not on script load

(() => {
  if (window.__sra_webgazer_bootstrap_loaded) return;
  window.__sra_webgazer_bootstrap_loaded = true;

  const scriptEl = document.currentScript;
  const wgUrl    = scriptEl && scriptEl.dataset && scriptEl.dataset.webgazerUrl;

  if (!wgUrl) {
    console.warn('[TL;DR] webgazer-bootstrap: missing data-webgazer-url attribute.');
    return;
  }

  const s  = document.createElement('script');
  s.src    = wgUrl;

  s.onload = function () {
    if (typeof webgazer === 'undefined') {
      console.warn('[TL;DR] webgazer loaded but window.webgazer is not defined.');
      window.postMessage({ source: 'sra-control', type: 'cameraError', error: 'webgazer not defined' }, '*');
      return;
    }

    // Try clmtrackr first — it is fully bundled in webgazer.min.js and does NOT
    // fetch any models from external URLs (no tfhub.dev, no CSP issues).
    // TFFaceMesh (the default) downloads 3 neural net models from tfhub.dev on
    // every page load, which is blocked by strict CSPs on sites like Wikipedia.
    try {
      if (typeof webgazer.setTracker === 'function') {
        webgazer.setTracker('clmtrackr');
        console.log('[TL;DR] Using clmtrackr (bundled, no external models)');
      }
    } catch (trackerErr) {
      console.warn('[TL;DR] clmtrackr not available, using default tracker:', trackerErr.message);
    }

    // Set up gaze listener before .begin()
    try {
      webgazer.setRegression('ridge');
      webgazer.setGazeListener(function (data) {
        try { window.postMessage({ source: 'sra-webgazer', gaze: data }, '*'); } catch (e) {}
      });
    } catch (setupErr) {
      console.warn('[TL;DR] webgazer setup error:', setupErr.message);
    }

    // Hide all built-in UI overlays
    const hideUI = () => {
      try { webgazer.showPredictionPoints(false);  } catch (e) {}
      try { webgazer.showVideo(false);              } catch (e) {}
      try { webgazer.showFaceOverlay(false);        } catch (e) {}
      try { webgazer.showFaceFeedbackBox(false);    } catch (e) {}
    };
    hideUI();

    // .begin() returns a Promise. We only signal cameraReady when it resolves.
    // This is the correct moment — camera stream is open and tracking has started.
    const beginResult = webgazer.begin();
    const beginPromise = (beginResult && typeof beginResult.then === 'function')
      ? beginResult
      : Promise.resolve();

    beginPromise
      .then(function () {
        hideUI(); // call again — some builds re-show after begin()
        console.log('[TL;DR] webgazer.begin() resolved — camera ready');
        window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
      })
      .catch(function (err) {
        const msg = (err && err.message) ? err.message : String(err);
        console.warn('[TL;DR] webgazer.begin() failed:', msg);
        window.postMessage({ source: 'sra-control', type: 'cameraError', error: msg }, '*');
      });
  };

  s.onerror = function () {
    console.warn('[TL;DR] Failed to load webgazer bundle from:', wgUrl);
    window.postMessage({ source: 'sra-control', type: 'cameraError', error: 'script load failed' }, '*');
  };

  // Forward debug prediction-point toggle from content script
  window.addEventListener('message', function (ev) {
    try {
      if (ev.source === window && ev.data &&
          ev.data.source === 'sra-control' &&
          ev.data.type   === 'setPredictionPoints' &&
          typeof webgazer !== 'undefined') {
        webgazer.showPredictionPoints(!!ev.data.enabled);
      }
    } catch (e) {}
  }, false);

  (document.head || document.documentElement).appendChild(s);
})();