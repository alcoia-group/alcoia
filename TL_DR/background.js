// background service worker (MV3)
// Handles messages from content scripts and popup (notes saving, WebGazer injection)

// ── Local PDF redirect ─────────────────────────────────────────────────────────
// Chrome's native PDF viewer runs in a sandboxed renderer that content scripts
// cannot inject into. When a local file:// PDF is opened, redirect it to the
// extension's custom PDF viewer page, which has full TL;DR integration.
// Requires "Allow access to file URLs" to be enabled in chrome://extensions.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  const url = tab.url || '';
  if (!url) return;

  if (/^file:\/\/.+\.pdf(\?.*)?$/i.test(url)) {
    const viewerUrl = chrome.runtime.getURL('src/pdf-viewer/viewer.html') + '?src=' + encodeURIComponent(url);
    chrome.tabs.update(tabId, { url: viewerUrl });
    return;
  }

  if (/^file:\/\/.+\.pptx(\?.*)?$/i.test(url)) {
    const viewerUrl = chrome.runtime.getURL('src/pptx-viewer/viewer.html') + '?src=' + encodeURIComponent(url);
    chrome.tabs.update(tabId, { url: viewerUrl });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  if (msg.action === 'openTab') {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ status: 'ok' });
    return;
  }

  if (msg.action === 'saveNote') {
    chrome.storage.local.get({ sra_notes: [] }, (res) => {
      const notes = res.sra_notes || [];
      notes.unshift({ id: Date.now(), text: msg.note.text, meta: msg.note.meta || {} });
      chrome.storage.local.set({ sra_notes: notes }, () => {
        sendResponse({ status: 'ok' });
      });
    });
    return true;
  }

  if (msg.action === 'getNotes') {
    chrome.storage.local.get({ sra_notes: [] }, (res) => {
      sendResponse({ notes: res.sra_notes || [] });
    });
    return true;
  }

  if (msg.action === 'injectWebgazerBootstrap') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ status: 'error', error: 'no_tab' }); return; }

    try {
      const webgazerUrl = chrome.runtime.getURL('src/libs/webgazer.min.js');
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (wgUrl) => {
          try {
            if (window.__sra_webgazer_bootstrap_loaded) return;
            window.__sra_webgazer_bootstrap_loaded = true;
            const s = document.createElement('script');
            s.src = wgUrl;
            s.onload = function () {
              try {
                if (typeof webgazer !== 'undefined') {
                  webgazer.setRegression('ridge').setGazeListener(function (d) {
                    try { window.postMessage({ source: 'sra-webgazer', gaze: d }, '*'); } catch (e) {}
                  }).begin();
                  try { webgazer.showPredictionPoints(false); } catch (e) {}
                  window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
                } else {
                  console.warn('webgazer not available after load (scripting inject)');
                }
              } catch (e) { console.warn('webgazer init error (scripting inject)', e); }
            };
            s.onerror = function () { console.warn('Failed to load webgazer from', wgUrl); };
            (document.head || document.documentElement).appendChild(s);

            window.addEventListener('message', function (ev) {
              try {
                if (ev && ev.source === window && ev.data &&
                    ev.data.source === 'sra-control' && ev.data.type === 'setPredictionPoints') {
                  if (typeof webgazer !== 'undefined' && typeof webgazer.showPredictionPoints === 'function') {
                    webgazer.showPredictionPoints(!!ev.data.enabled);
                  }
                }
              } catch (e) {}
            }, false);
          } catch (e) { console.warn('webgazer scripting bootstrap failed', e); }
        },
        args: [webgazerUrl],
      }, () => {
        sendResponse({ status: 'ok' });
      });
    } catch (e) {
      sendResponse({ status: 'error', error: String(e) });
    }
    return true;
  }
});
