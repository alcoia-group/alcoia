// webgazer-bootstrap.js — Runs in PAGE context (not extension isolated world)
// Handles all webgazer calls from page context since content script is isolated world.
// Receives URL via data-webgazer-url attribute (CSP-safe).

(() => {
  if (window.__sra_webgazer_bootstrap_loaded) return;
  window.__sra_webgazer_bootstrap_loaded = true;

  const scriptEl = document.currentScript;
  const wgUrl    = scriptEl && scriptEl.dataset && scriptEl.dataset.webgazerUrl;

  if (!wgUrl) {
    console.warn('[TL;DR] bootstrap: missing data-webgazer-url');
    return;
  }

  const s = document.createElement('script');
  s.src   = wgUrl;

  s.onload = function () {
    if (typeof webgazer === 'undefined') {
      console.warn('[TL;DR] webgazer not defined after load');
      window.postMessage({ source: 'sra-control', type: 'cameraError', error: 'not defined' }, '*');
      return;
    }

    // Use clmtrackr — fully bundled, no external model downloads (no tfhub.dev CSP issues)
    // TFFaceMesh (default) downloads 3 neural nets from tfhub.dev which strict CSPs block.
    try {
      if (typeof webgazer.setTracker === 'function') {
        webgazer.setTracker('clmtrackr');
        console.log('[TL;DR] tracker: clmtrackr');
      }
    } catch (e) {
      console.warn('[TL;DR] clmtrackr unavailable:', e.message);
    }

    // Ridge regression is the best option for online learning from click data
    try { webgazer.setRegression('ridge'); } catch (e) {}

    // Gaze listener — forward to content script via postMessage
    try {
      webgazer.setGazeListener(function (data) {
        try { window.postMessage({ source: 'sra-webgazer', gaze: data }, '*'); } catch (e) {}
      });
    } catch (e) {}

    // Hide all built-in UI (we draw our own prediction dot when debug is on)
    function hideUI() {
      try { webgazer.showPredictionPoints(false); } catch (e) {}
      try { webgazer.showVideo(false);             } catch (e) {}
      try { webgazer.showFaceOverlay(false);       } catch (e) {}
      try { webgazer.showFaceFeedbackBox(false);   } catch (e) {}
    }
    hideUI();

    // begin() returns a Promise — only fire cameraReady when it resolves
    // (camera stream is actually open at this point, not just when the JS loaded)
    const p = webgazer.begin();
    const beginPromise = (p && typeof p.then === 'function') ? p : Promise.resolve();

    beginPromise
      .then(function () {
        hideUI();
        console.log('[TL;DR] webgazer.begin() resolved — camera open');
        window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
      })
      .catch(function (err) {
        const msg = err?.message || String(err);
        console.warn('[TL;DR] webgazer.begin() failed:', msg);
        window.postMessage({ source: 'sra-control', type: 'cameraError', error: msg }, '*');
      });
  };

  s.onerror = function () {
    console.warn('[TL;DR] Failed to load webgazer from:', wgUrl);
    window.postMessage({ source: 'sra-control', type: 'cameraError', error: 'load failed' }, '*');
  };

  // ── Message bridge ─────────────────────────────────────────────────────────
  // Handles messages from gaze-utils.js (content script isolated world)
  // so it can call webgazer methods that only exist in page context.
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.source !== window) return;
    const d = ev.data;

    // Calibration: record a click at a known screen position (trains the model)
    if (d.source === 'sra-cal-record' && typeof d.x === 'number') {
      try {
        webgazer.recordScreenPosition(d.x, d.y, 'click');
      } catch (e) {}
      return;
    }

    // Calibration: get current prediction for offset calculation
    if (d.source === 'sra-cal-predict' && d.sra_pred_id) {
      try {
        const pred = webgazer.getCurrentPrediction ? webgazer.getCurrentPrediction() : null;
        window.postMessage({ source: 'sra-cal-prediction', sra_pred_id: d.sra_pred_id, prediction: pred }, '*');
      } catch (e) {
        window.postMessage({ source: 'sra-cal-prediction', sra_pred_id: d.sra_pred_id, prediction: null }, '*');
      }
      return;
    }

    // Calibration: ping to check if webgazer is available
    if (d.source === 'sra-cal-ping' && d.sra_ping_id) {
      window.postMessage({
        source:     'sra-cal-pong',
        sra_ping_id: d.sra_ping_id,
        available:  typeof webgazer !== 'undefined',
      }, '*');
      return;
    }

    // Debug toggle: show/hide prediction dot
    if (d.source === 'sra-control' && d.type === 'setPredictionPoints') {
      try { webgazer.showPredictionPoints(!!d.enabled); } catch (e) {}
      return;
    }
  }, false);

  (document.head || document.documentElement).appendChild(s);
})();