// webgazer-bootstrap.js
// Runs in PAGE context. URL passed via data-webgazer-url attribute (CSP-safe).
//
// Key fix: this version no longer tries setTracker('clmtrackr') because newer
// webgazer builds removed clmtrackr. Only TFFacemesh is available.
// TFFacemesh downloads models from tfhub.dev — blocked by strict CSPs (Wikipedia etc).
// We detect this failure and report a clear, actionable error.

(() => {
  if (window.__sra_webgazer_bootstrap_loaded) return;
  window.__sra_webgazer_bootstrap_loaded = true;

  const scriptEl = document.currentScript;
  const wgUrl    = scriptEl && scriptEl.dataset && scriptEl.dataset.webgazerUrl;

  if (!wgUrl) {
    console.warn('[TL;DR] bootstrap: missing data-webgazer-url attribute');
    return;
  }

  // ── Secure context check ────────────────────────────────────────────────
  // WebGazer requires HTTPS or localhost. HTTP pages will always fail.
  if (!window.isSecureContext) {
    const msg = 'WebGazer requires HTTPS or localhost. This page uses plain HTTP — eye tracking cannot start here. Try a different page.';
    console.warn('[TL;DR]', msg);
    window.postMessage({ source: 'sra-control', type: 'cameraError', error: msg, code: 'insecure-context' }, '*');
    return;
  }

  // ── CSP pre-check: can we reach tfhub.dev? ─────────────────────────────
  // TFFacemesh (the only tracker in newer webgazer builds) downloads models
  // from tfhub.dev. Sites like Wikipedia, GitHub, and MDN block this domain
  // in their Content Security Policy. We detect this upfront and show a
  // clear error instead of letting WebGazer fail with a pile of console noise.
  const testUrl = 'https://tfhub.dev/favicon.ico';
  fetch(testUrl, { method: 'HEAD', mode: 'no-cors' })
    .then(() => {
      // tfhub.dev is reachable — proceed with loading WebGazer
      loadWebgazer(wgUrl);
    })
    .catch(() => {
      // tfhub.dev is blocked by CSP on this page
      const msg = "This page's Content Security Policy blocks tfhub.dev (required for WebGazer's face detector). Eye tracking won't work here. Try using TL;DR on a news article, documentation site, or any page without strict CSP.";
      console.warn('[TL;DR]', msg);
      window.postMessage({
        source: 'sra-control',
        type:   'cameraError',
        error:  msg,
        code:   'csp-blocks-tfhub',
      }, '*');
    });

  function loadWebgazer(url) {
    const s = document.createElement('script');
    s.src   = url;

    s.onload = function () {
      if (typeof webgazer === 'undefined') {
        const msg = 'webgazer loaded but window.webgazer is not defined';
        console.warn('[TL;DR]', msg);
        window.postMessage({ source: 'sra-control', type: 'cameraError', error: msg }, '*');
        return;
      }

      // List available trackers for debugging
      try {
        const trackers = webgazer.getTrackerNames ? webgazer.getTrackerNames() : ['TFFacemesh'];
        console.log('[TL;DR] WebGazer available trackers:', trackers);
      } catch (e) {}

      // Use TFFacemesh (the only option in newer webgazer builds)
      // clmtrackr was removed in webgazer v2.1+
      try { webgazer.setRegression('ridge'); } catch (e) {}

      // Set gaze listener BEFORE begin()
      try {
        webgazer.setGazeListener(function (data) {
          try { window.postMessage({ source: 'sra-webgazer', gaze: data }, '*'); } catch (e) {}
        });
      } catch (e) { console.warn('[TL;DR] setGazeListener failed:', e.message); }

      // Hide all built-in UI
      function hideUI() {
        try { webgazer.showPredictionPoints(false);  } catch (e) {}
        try { webgazer.showVideo(false);              } catch (e) {}
        try { webgazer.showFaceOverlay(false);        } catch (e) {}
        try { webgazer.showFaceFeedbackBox(false);    } catch (e) {}
      }
      hideUI();

      // begin() returns a Promise — only fire cameraReady when resolved
      let beginResult;
      try { beginResult = webgazer.begin(); } catch (e) {
        window.postMessage({ source: 'sra-control', type: 'cameraError', error: e.message }, '*');
        return;
      }

      const p = (beginResult && typeof beginResult.then === 'function')
        ? beginResult : Promise.resolve();

      p.then(function () {
        hideUI();
        console.log('[TL;DR] WebGazer camera ready');
        window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
      }).catch(function (err) {
        const msg = err && err.message ? err.message : String(err);
        // "Failed to fetch" at this stage means tfhub.dev was blocked mid-load
        const isCsp = msg.includes('fetch') || msg.includes('network');
        const friendly = isCsp
          ? "WebGazer's face detection model couldn't load (likely blocked by this page's CSP). Try a different page."
          : msg;
        console.warn('[TL;DR] webgazer.begin() failed:', friendly);
        window.postMessage({ source: 'sra-control', type: 'cameraError', error: friendly }, '*');
      });
    };

    s.onerror = function () {
      const msg = 'Failed to load webgazer bundle from: ' + url;
      console.warn('[TL;DR]', msg);
      window.postMessage({ source: 'sra-control', type: 'cameraError', error: msg }, '*');
    };

    (document.head || document.documentElement).appendChild(s);
  }

  // ── Message bridge (page context → calibration calls) ───────────────────
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.source !== window) return;
    const d = ev.data;

    if (d.source === 'sra-cal-record' && typeof d.x === 'number') {
      try { webgazer.recordScreenPosition(d.x, d.y, 'click'); } catch (e) {}
      return;
    }
    if (d.source === 'sra-cal-predict' && d.sra_pred_id) {
      try {
        const pred = webgazer.getCurrentPrediction ? webgazer.getCurrentPrediction() : null;
        window.postMessage({ source: 'sra-cal-prediction', sra_pred_id: d.sra_pred_id, prediction: pred }, '*');
      } catch (e) {
        window.postMessage({ source: 'sra-cal-prediction', sra_pred_id: d.sra_pred_id, prediction: null }, '*');
      }
      return;
    }
    if (d.source === 'sra-cal-ping' && d.sra_ping_id) {
      window.postMessage({
        source: 'sra-cal-pong', sra_ping_id: d.sra_ping_id,
        available: typeof webgazer !== 'undefined',
      }, '*');
      return;
    }
    if (d.source === 'sra-control' && d.type === 'setPredictionPoints') {
      try { webgazer.showPredictionPoints(!!d.enabled); } catch (e) {}
    }
  }, false);

})();

    // ── Model save/restore bridge ───────────────────────────────────────────────
    // Handles messages from gaze-utils.js to serialise/restore the regression model
    window.addEventListener('message', function(ev) {
      if (!ev.data || ev.source !== window) return;
      const d = ev.data;

      if (d.source === 'sra-save-model' && d.id) {
        try {
          const data = webgazer.getData ? webgazer.getData() : null;
          // Store via content script bridge
          window.postMessage({
            source:    'sra-model-data',
            id:        d.id,
            modelData: data ? JSON.stringify(data) : null,
          }, '*');
          // Also directly cache in localStorage as backup
          if (data) localStorage.setItem('sra_webgazer_model', JSON.stringify(data));
        } catch (e) {
          window.postMessage({ source: 'sra-model-saved', id: d.id }, '*');
        }
        window.postMessage({ source: 'sra-model-saved', id: d.id }, '*');
        return;
      }

      if (d.source === 'sra-restore-model' && d.id && d.modelData) {
        try {
          const parsed = typeof d.modelData === 'string' ? JSON.parse(d.modelData) : d.modelData;
          if (webgazer.setData) webgazer.setData(parsed);
          console.log('[TL;DR] WebGazer model restored');
        } catch (e) {
          console.warn('[TL;DR] Model restore failed:', e.message);
        }
        window.postMessage({ source: 'sra-model-restored', id: d.id }, '*');
        return;
      }
    }, false);