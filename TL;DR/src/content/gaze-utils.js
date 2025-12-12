/* gaze-utils.js
   Responsibilities:
   - Normalize incoming gaze data to client (viewport) coordinates
   - Apply calibration offsets stored in chrome.storage
   - Exponential smoothing (EMA)
   - Dropout handling configuration
   - Velocity checking to reject spikes
*/

let _state = null;

export function createGazeState(opts = {}) {
  const state = {
    smoothingAlpha: typeof opts.smoothingAlpha === 'number' ? opts.smoothingAlpha : 0.18,
    dropoutFrames: typeof opts.dropoutFrames === 'number' ? opts.dropoutFrames : 3,
    velocityThreshold: typeof opts.velocityThreshold === 'number' ? opts.velocityThreshold : 1200, // pixels/sec
    last: { x: null, y: null, t: null },
    ema: { x: null, y: null }
    ,
    // live calibration offsets applied to smoothed gaze points
    calibration: { dx: 0, dy: 0 }
  };
  _state = state;
  // asynchronously load stored calibration into state so normalizeAndSmooth can read synchronously
  getCalibration().then((c) => {
    try { if (c && typeof c.dx === 'number' && typeof c.dy === 'number') state.calibration = c; }
    catch (e) { /* ignore */ }
  }).catch(()=>{});
  return state;
}

// load calibration offsets from storage (dx, dy)
export async function getCalibration() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ sra_calibration: { dx: 0, dy: 0 } }, (res) => resolve(res.sra_calibration || { dx: 0, dy: 0 }));
  });
}

export async function setCalibration(offset) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ sra_calibration: offset }, () => {
      // update in-memory state if present
      try { if (_state) _state.calibration = offset || { dx: 0, dy: 0 }; } catch (e) {}
      resolve();
    });
  });
}

// Normalize raw webgazer data object to client coords
// webgazer returns x/y in window coordinates for most builds; we detect and convert robustly.
export function normalizeRawToClient(raw) {
  if (!raw) return null;
  // webgazer historically returns { x, y } in page coords or client coords depending on version.
  // Heuristic: if x is larger than window.innerWidth by >100, treat as pageX and subtract scrollX
  let x = raw.x, y = raw.y;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  // If coordinates look like page coords (bigger than viewport), convert
  if (x > window.innerWidth + 100 || y > window.innerHeight + 100) {
    x = x - window.scrollX; y = y - window.scrollY;
  }
  // apply devicePixelRatio correction if values seem scaled
  const dpr = window.devicePixelRatio || 1;
  if (dpr && Math.abs(Math.round(dpr) - dpr) > 0.001 && dpr !== 1) {
    // only adjust if coordinates appear multiplied
    x = x / dpr; y = y / dpr;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

export function normalizeAndSmooth(raw, state) {
  const client = normalizeRawToClient(raw);
  if (!client) return null;
  // apply calibration offset from in-memory state (loaded asynchronously at createGazeState)
  const cal = (state && state.calibration) ? state.calibration : { dx: 0, dy: 0 };
  // smoothing (EMA)
  if (state.ema.x === null) { state.ema.x = client.x; state.ema.y = client.y; state.last.t = performance.now(); state.last.x = client.x; state.last.y = client.y; return { x: client.x + cal.dx, y: client.y + cal.dy }; }
  state.ema.x = (1 - state.smoothingAlpha) * state.ema.x + state.smoothingAlpha * client.x;
  state.ema.y = (1 - state.smoothingAlpha) * state.ema.y + state.smoothingAlpha * client.y;
  state.last.t = performance.now(); state.last.x = state.ema.x; state.last.y = state.ema.y;
  return { x: state.ema.x + cal.dx, y: state.ema.y + cal.dy };
}

export function checkVelocity(state, point) {
  if (!state || !state.last || state.last.t === null) { state.last = { x: point.x, y: point.y, t: performance.now() }; return true; }
  const now = performance.now();
  const dt = Math.max(1, now - (state.last.t || now));
  const dx = point.x - (state.last.x || point.x); const dy = point.y - (state.last.y || point.y);
  const speed = Math.sqrt(dx*dx + dy*dy) / (dt / 1000); // px/sec
  state.last = { x: point.x, y: point.y, t: now };
  if (speed > state.velocityThreshold) return false;
  return true;
}

// small helper to run a calibration flow: show N points and compute average offset
export async function runCalibrationSequence(points = [{x:0.1,y:0.1},{x:0.9,y:0.1},{x:0.5,y:0.5},{x:0.1,y:0.9},{x:0.9,y:0.9}]) {
  return new Promise(async (resolve) => {
    // if webgazer isn't present, return zero offsets
    if (typeof webgazer === 'undefined' || !webgazer.getCurrentPrediction) {
      const zero = { dx: 0, dy: 0 };
      await setCalibration(zero);
      return resolve(zero);
    }

    const overlay = document.createElement('div'); overlay.className = 'sra-cal-overlay';
    overlay.innerHTML = `
      <div class="sra-cal-panel">
        <div class="sra-cal-top">
          <div class="sra-cal-steps" aria-hidden="true"></div>
          <div class="sra-cal-progress"><div class="sra-cal-fill" style="width:0%"></div></div>
          <button class="sra-cal-retry">Retry</button>
        </div>
        <div class="sra-cal-target-area"><div class="sra-cal-target" style="left:0;top:0"></div></div>
      </div>
    `;
    document.body.appendChild(overlay);
    // fade in
    requestAnimationFrame(()=> overlay.classList.add('visible'));

    const panel = overlay.querySelector('.sra-cal-panel');
    const target = overlay.querySelector('.sra-cal-target');
    const fill = overlay.querySelector('.sra-cal-fill');
    const stepsEl = overlay.querySelector('.sra-cal-steps');
    const retryBtn = overlay.querySelector('.sra-cal-retry');

    // render step indicators
    stepsEl.innerHTML = '';
    for (let k=0;k<points.length;k++) { const e = document.createElement('div'); e.className = 'sra-cal-step'; stepsEl.appendChild(e); }
    const stepNodes = Array.from(stepsEl.children);

    let results = [];
    let idx = 0;
    let cancelled = false;

    retryBtn.addEventListener('click', () => {
      // restart
      results = []; idx = 0; stepNodes.forEach(n=>n.classList.remove('active'));
      fill.style.width = '0%';
      moveTo(points[0]);
      runStep();
    });

    function moveTo(p) {
      const left = (p.x * 100) + '%'; const top = (p.y * 100) + '%';
      target.style.left = left; target.style.top = top; // CSS handles smooth transition
    }

    async function collectSamplesForPoint(nSamples = 12, timeoutMs = 1400) {
      return new Promise((res) => {
        const samples = [];
        let elapsed = 0; const interval = 100; const maxTicks = Math.ceil(timeoutMs / interval);
        let ticks = 0;
        const t = setInterval(() => {
          try {
            const d = webgazer.getCurrentPrediction && webgazer.getCurrentPrediction();
            if (d) { const norm = normalizeRawToClient(d); if (norm) samples.push(norm); }
          } catch (e) {}
          ticks++; elapsed += interval;
          if (samples.length >= nSamples || ticks >= maxTicks) { clearInterval(t); const avg = samples.reduce((acc,s)=>({x:acc.x+s.x,y:acc.y+s.y}),{x:0,y:0}); if (samples.length) { avg.x/=samples.length; avg.y/=samples.length; } res(avg); }
        }, interval);
      });
    }

    async function runStep() {
      if (cancelled) return;
      const p = points[idx];
      // move target
      moveTo(p);
      // mark active step
      stepNodes.forEach((n,i)=> n.classList.toggle('active', i===idx));
      // collect samples
      const avg = await collectSamplesForPoint(12, 1400);
      results.push(avg);
      idx++;
      // update progress fill
      const pct = Math.round((idx / points.length) * 100);
      fill.style.width = pct + '%';
      if (idx < points.length) {
        // move to next after short pause
        setTimeout(runStep, 300);
      } else {
        // finished
        overlay.classList.remove('visible');
        // allow fade out
        setTimeout(async () => {
          try { overlay.remove(); } catch (e) {}
          // compute offsets
          let dx = 0, dy = 0, count = 0;
          for (let j=0;j<results.length;j++){
            const r = results[j]; const t = points[j]; const tx = t.x * window.innerWidth; const ty = t.y * window.innerHeight;
            if (r && r.x) { dx += (tx - r.x); dy += (ty - r.y); count++; }
          }
          dx = dx / Math.max(1, count); dy = dy / Math.max(1, count);
          const offset = { dx, dy };
          await setCalibration(offset);
          resolve(offset);
        }, 260);
      }
    }

    // start
    moveTo(points[0]);
    setTimeout(runStep, 400);

    // allow cancellation if the overlay is clicked outside
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) {
        cancelled = true; overlay.classList.remove('visible'); setTimeout(()=>{ try{ overlay.remove(); }catch(e){}; resolve({dx:0,dy:0}); }, 220);
      }
    });
  });
}
