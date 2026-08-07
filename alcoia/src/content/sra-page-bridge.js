(function () {
  if (window.__sra_page_bridge_installed) return;
  window.__sra_page_bridge_installed = true;

  window.__sra_bridge = window.__sra_bridge || { _callbacks: {} };

  window.sra = window.sra || {};
  window.sra.runCalibration = function () {
    return new Promise((resolve, reject) => {
      try {
        const id = Math.random().toString(36).slice(2);
        window.__sra_bridge._callbacks[id] = { resolve, reject };

        window.postMessage(
          { source: 'sra-page', type: 'runCalibration', id },
          '*'
        );

        setTimeout(() => {
          if (window.__sra_bridge._callbacks[id]) {
            delete window.__sra_bridge._callbacks[id];
            reject(new Error('timeout'));
          }
        }, 15000);
      } catch (e) {
        reject(e);
      }
    });
  };

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'sra-content') return;

    if (e.data.type === 'calibrationResult' && e.data.id) {
      const cb = window.__sra_bridge._callbacks[e.data.id];
      if (cb) {
        cb.resolve(e.data.result);
        delete window.__sra_bridge._callbacks[e.data.id];
      }
    }
  });
})();