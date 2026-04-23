/* idle-overlay.js
   Detects when the user's gaze leaves the screen or becomes inactive,
   then pulses the viewport edges to draw attention back.

   How "not looking at screen" is detected:
   1. gaze_drift_px is very high (eyes wandering far off text)
   2. No gaze data received for > IDLE_TIMEOUT_MS (user looked away entirely)
   3. velocity_mean is near zero but scroll is also zero (frozen, not reading)

   The edge pulse uses a CSS box-shadow on a fixed full-viewport div.
   It does NOT use position:fixed on body (breaks scroll) or outline on html.
*/

// ── Create the edge overlay element ──────────────────────────────────────────
const OVERLAY_ID = 'sra-idle-overlay';

function getOrCreateOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;

  el = document.createElement('div');
  el.id = OVERLAY_ID;
  Object.assign(el.style, {
    position:        'fixed',
    inset:           '0',
    pointerEvents:   'none',        // never blocks clicks
    zIndex:          '2147483644',  // below popups (2147483647) but above everything else
    borderRadius:    '0',
    opacity:         '0',
    transition:      'opacity 0.4s ease',
    border:          '0px solid transparent',
  });
  document.body.appendChild(el);
  return el;
}

// ── Animation state ───────────────────────────────────────────────────────────
let pulseTimer     = null;
let pulseActive    = false;
let pulsePhase     = 0;
let idleStarted    = null;
const PULSE_INTERVAL = 600;    // ms between pulse steps
const FADE_DURATION  = 1800;   // ms to fully show the pulse
const IDLE_TIMEOUT   = 4000;   // ms of no gaze before triggering

// Green matches TL;DR's accent, fades to transparent at the outer edges
const PULSE_COLOR = 'rgba(26, 126, 93, ';

function startPulse() {
  if (pulseActive) return;
  pulseActive = true;
  const el = getOrCreateOverlay();

  // Pulse: cycle between two box-shadow sizes
  function step() {
    if (!pulseActive) return;
    pulsePhase = 1 - pulsePhase;
    const size    = pulsePhase ? '0px 0px 0px 8px' : '0px 0px 0px 14px';
    const opacity = pulsePhase ? '0.65' : '0.35';
    el.style.boxShadow = `inset ${size} ${PULSE_COLOR}0.55)`;
    el.style.opacity   = opacity;
    pulseTimer = setTimeout(step, PULSE_INTERVAL);
  }

  el.style.opacity = '1';
  step();
}

function stopPulse() {
  if (!pulseActive) return;
  pulseActive = false;
  clearTimeout(pulseTimer);
  const el = document.getElementById(OVERLAY_ID);
  if (el) { el.style.opacity = '0'; el.style.boxShadow = 'none'; }
  idleStarted = null;
}

// ── Public API — called from content.js ──────────────────────────────────────
export function updateIdleState(features, lastGazePt, gazeReceivedAt) {
  const now = Date.now();

  // Condition 1: no gaze data received for IDLE_TIMEOUT ms
  // (user looked away entirely, eyes closed, or camera lost face)
  const timeSinceGaze = now - gazeReceivedAt;
  if (timeSinceGaze > IDLE_TIMEOUT) {
    if (!idleStarted) idleStarted = now;
    startPulse();
    return;
  }

  // Condition 2: features say the user is zoning out (eyes drifting off text)
  // Only trigger if we have features AND the drift is very high
  if (features) {
    const isZoning = features.gaze_drift_px > 80 &&
                     features.scroll_delta_px < 5 &&
                     features.velocity_mean < 150;
    if (isZoning) {
      if (!idleStarted) idleStarted = now;
      // Only pulse if they've been zoning for > 3 seconds
      if (now - idleStarted > 3000) { startPulse(); return; }
    } else {
      stopPulse();
    }
    return;
  }

  stopPulse();
}

export function forceStopIdle() { stopPulse(); }