/* idle-overlay.js — v2
   Corner bracket design — four L-shaped brackets at the viewport corners.
   Much more visible than the thin inset box-shadow.
   Blinks continuously until the user's gaze returns to text content.
   Stops only when gaze is detected back on the page.
*/

const OVERLAY_ID = 'sra-idle-corners';

// ── Create corner brackets ─────────────────────────────────────────────────
function getOrCreateCorners() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;

  el = document.createElement('div');
  el.id = OVERLAY_ID;
  Object.assign(el.style, {
    position:      'fixed',
    inset:         '0',
    pointerEvents: 'none',
    zIndex:        '2147483644',
    opacity:       '0',
    transition:    'opacity 0.35s ease',
  });

  // Four corners — each is an L-shaped bracket made of two pseudo-divs
  const positions = [
    { top: '0',    left: '0',    borderTop: true,  borderLeft: true  },
    { top: '0',    right: '0',   borderTop: true,  borderRight: true },
    { bottom: '0', left: '0',    borderBottom: true, borderLeft: true },
    { bottom: '0', right: '0',   borderBottom: true, borderRight: true },
  ];

  positions.forEach(pos => {
    const corner = document.createElement('div');
    Object.assign(corner.style, {
      position: 'fixed',
      width:    '52px',
      height:   '52px',
      ...Object.fromEntries(
        Object.entries(pos).filter(([k]) => !k.startsWith('border'))
      ),
    });

    // Build border sides
    const THICKNESS = '5px';
    const COLOR     = 'rgba(26, 126, 93, VAL)';

    if (pos.borderTop)    corner.style.borderTop    = `${THICKNESS} solid ${COLOR.replace('VAL','0.9')}`;
    if (pos.borderBottom) corner.style.borderBottom = `${THICKNESS} solid ${COLOR.replace('VAL','0.9')}`;
    if (pos.borderLeft)   corner.style.borderLeft   = `${THICKNESS} solid ${COLOR.replace('VAL','0.9')}`;
    if (pos.borderRight)  corner.style.borderRight  = `${THICKNESS} solid ${COLOR.replace('VAL','0.9')}`;

    corner.style.borderRadius = '0px';
    el.appendChild(corner);
  });

  document.body.appendChild(el);
  return el;
}

// ── Animation state ────────────────────────────────────────────────────────
let pulseTimer    = null;
let pulseActive   = false;
let idleStartedAt = null;
let IDLE_TIMEOUT  = 4000;  // ms before triggering

// Blink: alternates between full opacity and near-zero, staying visible
let blinkState = true;

function startPulse() {
  if (pulseActive) return;
  pulseActive = true;
  const el = getOrCreateCorners();

  function blink() {
    if (!pulseActive) return;
    blinkState = !blinkState;
    el.style.opacity       = blinkState ? '1' : '0.15';
    el.style.transition    = blinkState ? 'opacity 0.18s ease' : 'opacity 0.45s ease';
    pulseTimer = setTimeout(blink, blinkState ? 500 : 700);
  }

  el.style.opacity = '1';
  blink();
}

function stopPulse() {
  if (!pulseActive) return;
  pulseActive   = false;
  idleStartedAt = null;
  clearTimeout(pulseTimer);
  const el = document.getElementById(OVERLAY_ID);
  if (el) {
    el.style.transition = 'opacity 0.4s ease';
    el.style.opacity    = '0';
  }
}

// ── Public API ─────────────────────────────────────────────────────────────
export function updateIdleState(features, lastGazePt, gazeReceivedAt) {
  const now = Date.now();

  // Condition 1: no gaze data at all (user looked away, camera lost face)
  const timeSinceGaze = now - gazeReceivedAt;
  if (timeSinceGaze > IDLE_TIMEOUT) {
    if (!idleStartedAt) idleStartedAt = now;
    startPulse();
    return;
  }

  // Condition 2: gaze data exists but eyes are drifting far off text
  if (features) {
    const isDrifting = features.gaze_drift_px    > 80 &&
                       features.scroll_delta_px  < 5  &&
                       features.velocity_mean    < 150;
    if (isDrifting) {
      if (!idleStartedAt) idleStartedAt = now;
      if (now - idleStartedAt > 3000) { startPulse(); return; }
    } else {
      // Eyes are back on content — stop pulsing
      stopPulse();
      return;
    }
    return;
  }

  // Gaze present and no drift — stop
  stopPulse();
}

export function forceStopIdle() { stopPulse(); }

export function setIdleTimeout(ms) { IDLE_TIMEOUT = ms || 4000; }