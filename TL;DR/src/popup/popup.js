document.addEventListener('DOMContentLoaded', () => {
  const assistantToggle = document.getElementById('assistantToggle');
  const eyeToggle = document.getElementById('eyeToggle');
  const selToggle = document.getElementById('selToggle');
  const backendUrlInput = document.getElementById('backendUrl');
  const upgradeBtn = document.getElementById('upgradeBtn');
  const autohideToggle = document.getElementById('autohideToggle');
  const autohideTimeoutInput = document.getElementById('autohideTimeout');
  const pinDefaultToggle = document.getElementById('pinDefaultToggle');
  const debugTogglePopup = document.getElementById('debugTogglePopup');
  const calibrateBtn = document.getElementById('calibrateBtn');
  const troubleshootBtn = document.getElementById('troubleshootBtn');

  // load saved settings
  // Note: default autohide set to false so popups stay until closed or pinned unless user enables autohide
  chrome.storage.local.get({ sra_backend_url: '', sra_eye: true, sra_selection: true, sra_autohide: false, sra_autohide_timeout: 12, sra_pin_default: false, sra_debug: false }, (res) => {
    backendUrlInput.value = res.sra_backend_url || 'http://localhost:3000/api/summarize';
    eyeToggle.checked = res.sra_eye !== false;
    selToggle.checked = res.sra_selection !== false;
    autohideToggle.checked = res.sra_autohide !== false;
    autohideTimeoutInput.value = res.sra_autohide_timeout || 12;
    pinDefaultToggle.checked = !!res.sra_pin_default;
    debugTogglePopup.checked = !!res.sra_debug;
  });

  function saveSettings() {
    const backendUrl = backendUrlInput.value.trim();
    const autohide = !!autohideToggle.checked;
    const timeoutSec = Number(autohideTimeoutInput.value) || 12;
    const pinDefault = !!pinDefaultToggle.checked;
    const debug = !!debugTogglePopup.checked;
    chrome.storage.local.set({ sra_backend_url: backendUrl, sra_eye: eyeToggle.checked, sra_selection: selToggle.checked, sra_autohide: autohide, sra_autohide_timeout: timeoutSec, sra_pin_default: pinDefault, sra_debug: debug });
    // send immediate message to content scripts to update
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'settings', backendUrl, eye: eyeToggle.checked, selection: selToggle.checked, autohide, autohideTimeout: timeoutSec, pinDefault, debug });
      // also send debug control to page via content script (content script will forward to page)
      chrome.tabs.sendMessage(tabs[0].id, { type: 'debugToggle', enabled: debug });
    });
  }

  backendUrlInput.addEventListener('change', saveSettings);
  eyeToggle.addEventListener('change', () => {
    saveSettings();
    // When eye tracking is enabled, send a message to start the camera
    if (eyeToggle.checked) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, { type: 'startCamera' }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('Failed to start camera:', chrome.runtime.lastError.message);
          }
        });
      });
      updateEyeTrackingStatus('Camera: starting...');
    } else {
      updateEyeTrackingStatus('Camera: off');
    }
  });
  selToggle.addEventListener('change', saveSettings);
  autohideToggle && autohideToggle.addEventListener('change', saveSettings);
  autohideTimeoutInput && autohideTimeoutInput.addEventListener('change', saveSettings);
  pinDefaultToggle && pinDefaultToggle.addEventListener('change', saveSettings);
  debugTogglePopup && debugTogglePopup.addEventListener('change', saveSettings);

  assistantToggle.addEventListener('change', (e) => {
    // toggle assistant globally (for future expansion; for now we'll enable/disable via storage)
    const enabled = assistantToggle.checked;
    chrome.storage.local.set({ sra_enabled: enabled });
  });

  calibrateBtn && calibrateBtn.addEventListener('click', async () => {
    // launch calibration flow in active tab
      calibrateBtn.disabled = true;
      calibrateBtn.textContent = 'Starting...';
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // 1) Try sendMessage to content script (preferred, reliable when content script is loaded)
        const tryMessage = () => new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { type: 'runCalibration' }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('sendMessage failed:', chrome.runtime.lastError.message);
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else if (!response) {
              console.warn('no response from content script');
              resolve({ ok: false, error: 'no-response' });
            } else {
              resolve({ ok: true, response });
            }
          });
        });

        let res = await tryMessage();

        // 2) If message failed (no listener), inject the content script programmatically and try again.
        if (!res.ok) {
          console.log('Attempting to inject content script into tab...', tab.id);
          try {
            // Inject the content script file so it registers its message listener in the page
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['src/content/content.js']
            });
            // Give it a moment to initialize
            await new Promise((r) => setTimeout(r, 250));
            res = await tryMessage();
          } catch (injectErr) {
            console.error('Injection attempt failed', injectErr);
            res = { ok: false, error: injectErr.message };
          }
        }

        if (!res.ok) {
          // fallback: try executeScript to call runCalibration on window.sra directly (may be undefined)
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: async () => {
                if (window.sra && window.sra.runCalibration) {
                  await window.sra.runCalibration();
                } else {
                  console.warn('window.sra not found on page (fallback)');
                }
              }
            });
          } catch (execErr) {
            console.error('Fallback executeScript failed', execErr);
            throw execErr;
          }
        }

        console.log('Calibration request completed (check page for overlay)');
      } catch (err) {
        console.error('Calibration handler error', err);
        alert('Calibration failed: ' + (err && err.message ? err.message : String(err)));
      } finally {
        calibrateBtn.disabled = false;
        calibrateBtn.textContent = 'Calibrate eye tracker';
      }
  });

  troubleshootBtn && troubleshootBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/content/camera' });
  });

  // Add a "Start Camera" button before calibrate
  const startCameraBtn = document.createElement('button');
  startCameraBtn.id = 'startCameraBtn';
  startCameraBtn.className = 'tool';
  startCameraBtn.textContent = 'Start Camera (Show Points)';
  const toolsSection = document.querySelector('.tools');
  if (toolsSection) toolsSection.insertBefore(startCameraBtn, calibrateBtn);
  
  startCameraBtn.addEventListener('click', async () => {
    startCameraBtn.disabled = true;
    startCameraBtn.textContent = 'Starting camera...';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, { type: 'startCamera' }, (response) => {
        if (chrome.runtime.lastError) {
          alert('Camera failed to start. Check camera permissions and try Troubleshoot Camera.');
          updateEyeTrackingStatus('Camera: permission denied');
        } else {
          updateEyeTrackingStatus('Camera: active');
        }
      });
    } catch (err) {
      console.error('Start camera error', err);
      alert('Could not start camera: ' + err.message);
    } finally {
      startCameraBtn.disabled = false;
      startCameraBtn.textContent = 'Start Camera (Show Points)';
    }
  });

  // Helper to update status text
  function updateEyeTrackingStatus(text) {
    const statusDiv = document.getElementById('eyeTrackingStatus');
    const statusText = document.getElementById('statusText');
    if (statusDiv && statusText) {
      statusText.textContent = text;
      statusDiv.style.display = 'block';
    }
  }

  // Initialize status display
  if (eyeToggle.checked) {
    updateEyeTrackingStatus('Camera: off (click Start Camera)');
  }

  // Open local offline upgrade page instead of external URL
  upgradeBtn.addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/upgrade.html') }); });

  // set logo image from bundled assets (if present)
  try {
    const logoImg = document.getElementById('sra-logo-img');
    if (logoImg) { logoImg.src = chrome.runtime.getURL('assets/tldr.png'); }
  } catch (e) { /* ignore in non-extension contexts */ }
});
