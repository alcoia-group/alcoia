/* gaze-utils.js — v3
   Added:
   - WebGazer model persistence (save/restore between pages)
   - Calibration data survives page navigation
*/

let _state = null;

export function createGazeState(opts = {}) {
  const state = {
    smoothingAlpha:    typeof opts.smoothingAlpha    === 'number' ? opts.smoothingAlpha    : 0.12,
    dropoutFrames:     typeof opts.dropoutFrames     === 'number' ? opts.dropoutFrames     : 4,
    velocityThreshold: typeof opts.velocityThreshold === 'number' ? opts.velocityThreshold : 1000,
    last: { x: null, y: null, t: null },
    ema:  { x: null, y: null },
    calibration: { dx: 0, dy: 0 },
  };
  _state = state;
  getCalibration().then(c => {
    try { if (c && typeof c.dx === 'number') state.calibration = c; } catch (e) {}
  }).catch(() => {});
  return state;
}

export async function getCalibration() {
  return new Promise(resolve => {
    chrome.storage.local.get({ sra_calibration: { dx: 0, dy: 0 } },
      res => resolve(res.sra_calibration || { dx: 0, dy: 0 }));
  });
}

export async function setCalibration(offset) {
  return new Promise(resolve => {
    chrome.storage.local.set({ sra_calibration: offset }, () => {
      try { if (_state) _state.calibration = offset || { dx: 0, dy: 0 }; } catch (e) {}
      resolve();
    });
  });
}

// ── WebGazer model persistence ─────────────────────────────────────────────────
// WebGazer's ridge regression learns from calibration clicks. Without persistence,
// every new page starts with a blank model even if you just calibrated.
// We serialise the model weights to chrome.storage and restore them on load.

export function saveWebgazerModel() {
  // Runs in isolated world — delegates to bootstrap via postMessage
  return new Promise(resolve => {
    const id = 'save-' + Math.random().toString(36).slice(2);
    const handler = (ev) => {
      if (!ev.data || ev.data.source !== 'sra-model-saved' || ev.data.id !== id) return;
      window.removeEventListener('message', handler);
      resolve();
    };
    window.addEventListener('message', handler);
    window.postMessage({ source: 'sra-save-model', id }, '*');
    setTimeout(() => { window.removeEventListener('message', handler); resolve(); }, 1500);
  });
}

export function restoreWebgazerModel() {
  // Loads serialised model from storage and sends to bootstrap to apply
  return new Promise(resolve => {
    chrome.storage.local.get({ sra_webgazer_model: null }, (res) => {
      if (!res.sra_webgazer_model) { resolve(false); return; }
      const id = 'restore-' + Math.random().toString(36).slice(2);
      const handler = (ev) => {
        if (!ev.data || ev.data.source !== 'sra-model-restored' || ev.data.id !== id) return;
        window.removeEventListener('message', handler);
        resolve(true);
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: 'sra-restore-model', id, modelData: res.sra_webgazer_model }, '*');
      setTimeout(() => { window.removeEventListener('message', handler); resolve(false); }, 1500);
    });
  });
}

// ── Normalise and smooth ────────────────────────────────────────────────────────
export function normalizeRawToClient(raw) {
  if (!raw) return null;
  let x = raw.x, y = raw.y;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (x > window.innerWidth + 100 || y > window.innerHeight + 100) {
    x -= window.scrollX; y -= window.scrollY;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

export function normalizeAndSmooth(raw, state) {
  const client = normalizeRawToClient(raw);
  if (!client) return null;
  const cal = (state && state.calibration) ? state.calibration : { dx: 0, dy: 0 };
  if (state.ema.x === null) {
    state.ema.x = client.x; state.ema.y = client.y;
    state.last  = { x: client.x, y: client.y, t: performance.now() };
    return { x: client.x + cal.dx, y: client.y + cal.dy };
  }
  state.ema.x = (1 - state.smoothingAlpha) * state.ema.x + state.smoothingAlpha * client.x;
  state.ema.y = (1 - state.smoothingAlpha) * state.ema.y + state.smoothingAlpha * client.y;
  state.last  = { x: state.ema.x, y: state.ema.y, t: performance.now() };
  return { x: state.ema.x + cal.dx, y: state.ema.y + cal.dy };
}

export function checkVelocity(state, point) {
  if (!state?.last?.t) { state.last = { x: point.x, y: point.y, t: performance.now() }; return true; }
  const now = performance.now();
  const dt  = Math.max(1, now - state.last.t);
  const dx  = point.x - state.last.x;
  const dy  = point.y - state.last.y;
  const spd = Math.sqrt(dx*dx + dy*dy) / (dt / 1000);
  state.last = { x: point.x, y: point.y, t: now };
  return spd <= state.velocityThreshold;
}

// ── Calibration sequence ────────────────────────────────────────────────────────
export async function runCalibrationSequence() {
  return new Promise(async (resolve) => {

    // First: try to restore a previously saved model
    // This means a returning user doesn't need to recalibrate from scratch
    const restored = await restoreWebgazerModel();
    if (restored) console.log('[TL;DR] Restored WebGazer model from previous session');

    const wgAvailable = await new Promise(res => {
      const id = Math.random().toString(36).slice(2);
      const handler = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.sra_ping_id !== id) return;
        if (ev.data.source !== 'sra-cal-pong') return;
        window.removeEventListener('message', handler);
        res(ev.data.available);
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: 'sra-cal-ping', sra_ping_id: id }, '*');
      setTimeout(() => { window.removeEventListener('message', handler); res(false); }, 800);
    });

    if (!wgAvailable) {
      console.warn('[TL;DR] WebGazer not available for calibration — skipping');
      resolve({ dx: 0, dy: 0 }); return;
    }

    const GRID   = [[0.1,0.1],[0.5,0.1],[0.9,0.1],[0.1,0.5],[0.5,0.5],[0.9,0.5],[0.1,0.9],[0.5,0.9],[0.9,0.9]];
    const POINTS = [...GRID, ...GRID];
    const TOTAL  = POINTS.length;

    const overlay = document.createElement('div');
    overlay.className = 'sra-cal-overlay';
    overlay.innerHTML = `
      <div class="sra-cal-panel">
        <div class="sra-cal-top">
          <div class="sra-cal-steps" id="sra-cal-steps"></div>
          <div class="sra-cal-progress"><div class="sra-cal-fill" id="sra-cal-fill" style="width:0%"></div></div>
          <button class="sra-cal-retry" id="sra-cal-retry">Restart</button>
        </div>
        <p style="font-size:12px;color:#7a7a72;font-style:italic;text-align:center;margin:0">
          Click each dot as it appears. Two passes for accuracy.
        </p>
        <div class="sra-cal-target-area" id="sra-cal-area">
          <div class="sra-cal-target" id="sra-cal-target" style="left:50%;top:50%"></div>
        </div>
        <p class="sra-cal-hint">Look at the dot, then click it &mdash;
          <span id="sra-cal-counter">0</span> / ${TOTAL}</p>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const fill     = overlay.querySelector('#sra-cal-fill');
    const target   = overlay.querySelector('#sra-cal-target');
    const area     = overlay.querySelector('#sra-cal-area');
    const counter  = overlay.querySelector('#sra-cal-counter');
    const stepsEl  = overlay.querySelector('#sra-cal-steps');
    const retry    = overlay.querySelector('#sra-cal-retry');

    stepsEl.innerHTML = '';
    for (let i = 0; i < TOTAL; i++) {
      const d = document.createElement('div');
      d.className = 'sra-cal-step';
      stepsEl.appendChild(d);
    }
    const stepNodes = Array.from(stepsEl.children);

    let idx = 0, cancelled = false;

    function moveDotTo(px, py) {
      target.style.left = (px * 100) + '%';
      target.style.top  = (py * 100) + '%';
    }

    function updateProgress() {
      fill.style.width = ((idx / TOTAL) * 100) + '%';
      counter.textContent = idx;
      stepNodes.forEach((n, i) => n.classList.toggle('active', i === idx));
    }

    function showPoint() {
      if (cancelled || idx >= TOTAL) return;
      const [px, py] = POINTS[idx];
      moveDotTo(px, py);
      updateProgress();
      target.style.transform = 'translate(-50%,-50%) scale(1.4)';
      setTimeout(() => { target.style.transform = 'translate(-50%,-50%) scale(1)'; }, 200);
    }

    area.addEventListener('click', async (e) => {
      if (cancelled || idx >= TOTAL) return;
      const areaRect = area.getBoundingClientRect();
      const [px, py] = POINTS[idx];
      const dotScreenX = areaRect.left + px * areaRect.width;
      const dotScreenY = areaRect.top  + py * areaRect.height;
      window.postMessage({ source: 'sra-cal-record', x: dotScreenX, y: dotScreenY }, '*');
      idx++;
      updateProgress();
      if (idx >= TOTAL) finish();
      else setTimeout(showPoint, 350);
    });

    async function finish() {
      overlay.classList.remove('visible');
      setTimeout(async () => {
        try { overlay.remove(); } catch (e) {}

        const centreX = window.innerWidth  / 2;
        const centreY = window.innerHeight / 2;
        const offset  = await new Promise(res => {
          const id = Math.random().toString(36).slice(2);
          const h  = (ev) => {
            if (ev.source !== window || !ev.data || ev.data.sra_pred_id !== id) return;
            if (ev.data.source !== 'sra-cal-prediction') return;
            window.removeEventListener('message', h);
            const pred = ev.data.prediction;
            if (pred && typeof pred.x === 'number')
              res({ dx: Math.round(centreX - pred.x), dy: Math.round(centreY - pred.y) });
            else res({ dx: 0, dy: 0 });
          };
          window.addEventListener('message', h);
          window.postMessage({ source: 'sra-cal-predict', sra_pred_id: id }, '*');
          setTimeout(() => { window.removeEventListener('message', h); res({ dx: 0, dy: 0 }); }, 1000);
        });

        await setCalibration(offset);

        // Save the model immediately after calibration so it persists
        await saveWebgazerModel();
        console.log('[TL;DR] Calibration + model saved');
        resolve(offset);
      }, 280);
    }

    retry.addEventListener('click', () => {
      idx = 0;
      stepNodes.forEach(n => n.classList.remove('active'));
      fill.style.width    = '0%';
      counter.textContent = '0';
      showPoint();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cancelled = true;
        overlay.classList.remove('visible');
        setTimeout(() => { try { overlay.remove(); } catch(e){} resolve({ dx: 0, dy: 0 }); }, 250);
      }
    });

    showPoint();
  });
}