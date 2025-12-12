// background service worker (MV3)
// Handles messages from content scripts and popup (notes saving, simple routing)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  if (msg.action === 'saveNote') {
    // save note into chrome.storage.local under 'sra_notes'
    chrome.storage.local.get({ sra_notes: [] }, (res) => {
      const notes = res.sra_notes || [];
      notes.unshift({ id: Date.now(), text: msg.note.text, meta: msg.note.meta || {} });
      chrome.storage.local.set({ sra_notes: notes }, () => {
        sendResponse({ status: 'ok' });
      });
    });
    // indicate we will respond asynchronously
    return true;
  }

  if (msg.action === 'getNotes') {
    chrome.storage.local.get({ sra_notes: [] }, (res) => {
      sendResponse({ notes: res.sra_notes || [] });
    });
    return true;
  }

  // Pass-through for other actions
});

// Allow content scripts to request a privileged injection into the page's main world
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.action !== 'injectWebgazerBootstrap') return;
  // Ensure we have a tab id to target
  const tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) { sendResponse({ status: 'error', error: 'no_tab' }); return; }

  try {
    const webgazerUrl = chrome.runtime.getURL('src/libs/webgazer.min.js');
    // Use the scripting API to inject a small function into the page's MAIN world.
    // We pass the computed URL as an argument so the function can create a script tag.
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (wgUrl) => {
        try {
          if (window.__sra_webgazer_bootstrap_loaded) return;
          window.__sra_webgazer_bootstrap_loaded = true;
          const s = document.createElement('script');
          s.src = wgUrl;
          s.onload = function(){
            try {
              if (typeof webgazer !== 'undefined'){
                webgazer.setRegression('ridge').setGazeListener(function(d){
                  try { window.postMessage({ source: 'sra-webgazer', gaze: d }, '*'); } catch(e){}
                }).begin();
                try { webgazer.showPredictionPoints(false); } catch(e){}
                window.postMessage({ source: 'sra-control', type: 'cameraReady' }, '*');
              } else {
                console.warn('webgazer not available after load (scripting inject)');
              }
            } catch(e) { console.warn('webgazer init error (scripting inject)', e); }
          };
          s.onerror = function(){ console.warn('Failed to load webgazer from', wgUrl); };
          (document.head || document.documentElement).appendChild(s);

          // listen for control messages from the content script to toggle debug visuals
          window.addEventListener('message', function(ev){
            try {
              if (ev && ev.source === window && ev.data && ev.data.source === 'sra-control' && ev.data.type === 'setPredictionPoints') {
                if (typeof webgazer !== 'undefined' && typeof webgazer.showPredictionPoints === 'function') {
                  webgazer.showPredictionPoints(!!ev.data.enabled);
                }
              }
            } catch(e){}
          }, false);
        } catch(e) { console.warn('webgazer scripting bootstrap failed', e); }
      },
      args: [webgazerUrl]
    }, () => {
      // respond to the sender that the injection was attempted
      sendResponse({ status: 'ok' });
    });
  } catch (e) {
    sendResponse({ status: 'error', error: String(e) });
  }
  // indicate async response
  return true;
});
