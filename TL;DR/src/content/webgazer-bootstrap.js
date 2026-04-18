(() => {
  if (window.__sra_webgazer_bootstrap_loaded) return;
  window.__sra_webgazer_bootstrap_loaded = true;

  const s = document.createElement('script');
  s.src = const EXT_URL = window.location.origin;

  s.onload = function () {
    if (typeof webgazer !== 'undefined') {
      webgazer
        .setRegression('ridge')
        .setGazeListener(function (d) {
          window.postMessage({ source: 'sra-webgazer', gaze: d }, '*');
        })
        .begin();

      webgazer.showPredictionPoints(true); // IMPORTANT
      webgazer.applyKalmanFilter(true);

      window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
    }
  };

  (document.head || document.documentElement).appendChild(s);
})();