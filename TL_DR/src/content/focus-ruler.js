/* focus-ruler.js
   A horizontal focus band that follows the user's gaze Y position.
   Everything above and below the band is dimmed, keeping the eye anchored
   to the current reading line. Especially helpful for dyslexic readers and
   people who lose their place in long paragraphs.
*/

const RULER_ID    = 'sra-focus-ruler';
const BAND_PX     = 52;   // px half-height of the clear window (full band = 104px)
const DIM_OPACITY = 0.38; // darkness of the dim panels
const SMOOTH_K    = 0.14; // EMA alpha for ruler Y (slower than gaze EMA — avoids jitter)

export function createFocusRuler() {
  let enabled  = false;
  let smoothY  = null;
  let rafPending = false;
  let pendingY   = null;

  function ensureDOM() {
    if (document.getElementById(RULER_ID)) return;

    const ruler = document.createElement('div');
    ruler.id = RULER_ID;
    Object.assign(ruler.style, {
      position:      'fixed',
      inset:         '0',
      pointerEvents: 'none',
      zIndex:        '2147483638',
      display:       'none',
    });

    const top = document.createElement('div');
    top.id = 'sra-ruler-top';
    Object.assign(top.style, {
      position:   'absolute',
      left: '0', right: '0', top: '0',
      background: `rgba(0,0,0,${DIM_OPACITY})`,
    });

    const bot = document.createElement('div');
    bot.id = 'sra-ruler-bot';
    Object.assign(bot.style, {
      position:   'absolute',
      left: '0', right: '0', bottom: '0',
      background: `rgba(0,0,0,${DIM_OPACITY})`,
    });

    // Thin highlight line at the centre of the clear band
    const line = document.createElement('div');
    line.id = 'sra-ruler-line';
    Object.assign(line.style, {
      position:   'absolute',
      left: '0', right: '0',
      height:     '2px',
      background: 'rgba(26,126,93,0.30)',
    });

    ruler.appendChild(top);
    ruler.appendChild(bot);
    ruler.appendChild(line);
    document.body.appendChild(ruler);
  }

  function applyY(y) {
    const vh  = window.innerHeight;
    const top = document.getElementById('sra-ruler-top');
    const bot = document.getElementById('sra-ruler-bot');
    const ln  = document.getElementById('sra-ruler-line');
    if (!top || !bot || !ln) return;

    const clearTop = Math.max(0, y - BAND_PX);
    const clearBot = Math.max(0, vh - y - BAND_PX);

    top.style.height = clearTop + 'px';
    bot.style.height = clearBot + 'px';
    ln.style.top     = (y - 1) + 'px';
  }

  function scheduleUpdate(rawY) {
    pendingY = rawY;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!enabled || pendingY === null) return;
      smoothY = smoothY === null ? pendingY
        : (1 - SMOOTH_K) * smoothY + SMOOTH_K * pendingY;
      applyY(smoothY);
    });
  }

  return {
    enable() {
      enabled = true;
      ensureDOM();
      const ruler = document.getElementById(RULER_ID);
      if (ruler) ruler.style.display = 'block';
    },

    disable() {
      enabled = false;
      smoothY = null;
      const ruler = document.getElementById(RULER_ID);
      if (ruler) ruler.style.display = 'none';
    },

    update(gazeY) {
      if (!enabled) return;
      scheduleUpdate(gazeY);
    },

    isEnabled() { return enabled; },
  };
}
