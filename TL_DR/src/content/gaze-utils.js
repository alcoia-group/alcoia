/* gaze-utils.js
   - Normalize gaze data to client coords
   - Exponential smoothing (EMA)  
   - Velocity spike rejection
   - Click-based calibration (the CORRECT way to train WebGazer)

   IMPORTANT — Why click-based calibration:
   WebGazer uses ridge regression to map face/eye features → screen position.
   It learns from labelled examples: "when my face looked like THIS, I was looking at X,Y".
   Those examples come from webgazer.recordScreenPosition(x, y, 'click').
   Passively sampling getCurrentPrediction() just measures the current error —
   it does NOT train the model. Without click training data, WebGazer guesses.
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

// Normalize raw webgazer {x,y} to client (viewport) coords
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

// ── CLICK-BASED CALIBRATION ───────────────────────────────────────────────────
//
// The user sees a dot, clicks it, we call webgazer.recordScreenPosition().
// That gives WebGazer a (face features → known screen position) training example.
// After enough clicks, the ridge regression model improves significantly.
//
// 9 points in a 3×3 grid = good spatial coverage.
// Each point is clicked TWICE (two passes) for stability.
//
export async function runCalibrationSequence() {
  return new Promise(async (resolve) => {

    // Check webgazer is available in page context via postMessage bridge
    const wgAvailable = await new Promise(res => {
      const id = Math.random().toString(36).slice(2);
      const handler = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.sra_ping_id !== id || ev.data.source !== 'sra-cal-pong') return;
        window.removeEventListener('message', handler);
        res(ev.data.available);
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: 'sra-cal-ping', sra_ping_id: id }, '*');
      setTimeout(() => { window.removeEventListener('message', handler); res(false); }, 800);
    });

    if (!wgAvailable) {
      console.warn('[TL;DR] WebGazer not available for calibration — skipping');
      resolve({ dx: 0, dy: 0 });
      return;
    }

    // 9-point 3×3 grid (normalised 0–1)
    const GRID = [
      [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
      [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
      [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
    ];
    // Two passes for better accuracy
    const POINTS = [...GRID, ...GRID];
    const TOTAL  = POINTS.length;

    // ── Build overlay ──────────────────────────────────────────────────────
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
          Click each green dot as it appears. Two passes for accuracy.
        </p>
        <div class="sra-cal-target-area" id="sra-cal-area">
          <div class="sra-cal-target" id="sra-cal-target" style="left:50%;top:50%"></div>
        </div>
        <p class="sra-cal-hint" id="sra-cal-hint">Click the dot — <span id="sra-cal-counter">0</span> / ${TOTAL}</p>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const fill    = overlay.querySelector('#sra-cal-fill');
    const target  = overlay.querySelector('#sra-cal-target');
    const area    = overlay.querySelector('#sra-cal-area');
    const hint    = overlay.querySelector('#sra-cal-hint');
    const counter = overlay.querySelector('#sra-cal-counter');
    const stepsEl = overlay.querySelector('#sra-cal-steps');
    const retry   = overlay.querySelector('#sra-cal-retry');

    // Step dots
    stepsEl.innerHTML = '';
    for (let i = 0; i < TOTAL; i++) {
      const d = document.createElement('div');
      d.className = 'sra-cal-step';
      stepsEl.appendChild(d);
    }
    const stepNodes = Array.from(stepsEl.children);

    let idx = 0, cancelled = false;
    const predictions = [];

    function moveDotTo(px, py) {
      // px, py are 0–1 normalised within the target-area div
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
      // Pulse animation to draw eye
      target.style.transform = 'translate(-50%,-50%) scale(1.4)';
      setTimeout(() => { target.style.transform = 'translate(-50%,-50%) scale(1)'; }, 200);
    }

    // Click handler on the target area
    area.addEventListener('click', async (e) => {
      if (cancelled || idx >= TOTAL) return;

      const areaRect = area.getBoundingClientRect();
      const [px, py] = POINTS[idx];

      // Actual screen coordinates of the dot centre
      const dotScreenX = areaRect.left + px * areaRect.width;
      const dotScreenY = areaRect.top  + py * areaRect.height;

      // Record this click as a training example for WebGazer
      window.postMessage({
        source:  'sra-cal-record',
        x:       dotScreenX,
        y:       dotScreenY,
      }, '*');

      // Collect a prediction sample for offset computation
      window.postMessage({ source: 'sra-cal-sample', sra_sample_id: idx }, '*');

      idx++;
      updateProgress();

      if (idx >= TOTAL) {
        finish();
      } else {
        setTimeout(showPoint, 350);
      }
    });

    async function finish() {
      overlay.classList.remove('visible');
      setTimeout(async () => {
        try { overlay.remove(); } catch (e) {}

        // Ask page context for the current prediction at centre to compute residual offset
        const centreX = window.innerWidth  / 2;
        const centreY = window.innerHeight / 2;
        const offset  = await new Promise(res => {
          const id = Math.random().toString(36).slice(2);
          const h  = (ev) => {
            if (ev.source !== window || !ev.data || ev.data.sra_pred_id !== id || ev.data.source !== 'sra-cal-prediction') return;
            window.removeEventListener('message', h);
            const pred = ev.data.prediction;
            if (pred && typeof pred.x === 'number') {
              res({ dx: Math.round(centreX - pred.x), dy: Math.round(centreY - pred.y) });
            } else {
              res({ dx: 0, dy: 0 });
            }
          };
          window.addEventListener('message', h);
          window.postMessage({ source: 'sra-cal-predict', sra_pred_id: id }, '*');
          setTimeout(() => { window.removeEventListener('message', h); res({ dx: 0, dy: 0 }); }, 1000);
        });

        await setCalibration(offset);
        console.log('[TL;DR] Calibration complete. Offset:', offset);
        resolve(offset);
      }, 280);
    }

    retry.addEventListener('click', () => {
      idx = 0; predictions.length = 0;
      stepNodes.forEach(n => n.classList.remove('active'));
      fill.style.width = '0%';
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