// background service worker (MV3)
// Handles messages from content scripts and popup (notes saving, WebGazer injection)

// ── Local PDF redirect ─────────────────────────────────────────────────────────
// Chrome's native PDF viewer runs in a sandboxed renderer that content scripts
// cannot inject into. When a local file:// PDF is opened, redirect it to the
// extension's custom PDF viewer page, which has full alcoia integration.
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

  // Proxy AI summary requests. Content scripts can't call the local server
  // directly — their fetch carries the host page's origin, which the server's
  // CORS policy rejects. Fetching from here (the extension's own context) sends
  // no page origin, so the server accepts it and stays locked to the extension.
  // Generic POST proxy. 'summarize' is kept as the original name; 'apiPost'
  // is the same path for any other endpoint (questions, and whatever comes
  // next). Both exist for the same reason: a content script's fetch carries
  // the host page's origin, which the server's CORS policy rejects.
  if (msg.action === 'summarize' || msg.action === 'apiPost') {
    const url = msg.url || 'http://localhost:3000/api/summarize';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body || {}),
    })
      .then(async (resp) => {
        if (!resp.ok) { sendResponse({ ok: false, status: resp.status }); return; }
        const data = await resp.json();
        sendResponse({ ok: true, data });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      });
    return true; // keep the message channel open for the async response
  }

  if (msg.action === 'injectWebgazerBootstrap') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ status: 'error', error: 'no_tab' }); return; }

    // This path ends in webgazer.begin(), which calls getUserMedia. The content
    // script already refuses to ask unless the reader enabled the camera, but
    // the worker must not take that on trust — anything that can post a message
    // could otherwise start the webcam. Checked here as well, deliberately.
    chrome.storage.local.get({ sra_eye: false }, (cfg) => {
      if (cfg.sra_eye !== true) {
        sendResponse({ status: 'error', error: 'eye_tracking_disabled' });
        return;
      }
      injectWebgazer(tabId, sendResponse);
    });
    return true;
  }

  return false;
});

function injectWebgazer(tabId, sendResponse) {
  {
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
  }
}
