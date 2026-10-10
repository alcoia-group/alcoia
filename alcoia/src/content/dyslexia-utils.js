/* dyslexia-utils.js
   Dyslexia-friendly reading mode.

   What it does:
   - Switches body text to a clean sans-serif (Arial/Verdana — available everywhere,
     proven more readable for dyslexic readers than serif fonts)
   - Increases line-height and word/letter spacing
   - Forces left-alignment (justified text creates irregular word gaps that
     are harder for dyslexic readers to track)
   - Optional colour overlay (some readers benefit from a warm tint over white)

   Classifier threshold note: dyslexic readers naturally have higher regression
   rates and longer fixation times. content.js scales regression_rate tolerance
   when dyslexia mode is active to avoid false "confused" triggers.
*/

const CSS_ID     = 'sra-dyslexia-css';
const OVERLAY_ID = 'sra-dyslexia-overlay';

// ── CSS injection ─────────────────────────────────────────────────────────────
export function applyDyslexiaCSS(overlayColor = '') {
  removeDyslexiaCSS();

  const style = document.createElement('style');
  style.id = CSS_ID;
  style.textContent = `
    body, p, div, article, section, main, li, td, th, blockquote, span {
      font-family: Verdana, Arial, 'Helvetica Neue', sans-serif !important;
      line-height:     2.0  !important;
      letter-spacing:  0.06em !important;
      word-spacing:    0.14em !important;
      text-align:      left  !important;
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: Verdana, Arial, sans-serif !important;
      letter-spacing: 0.04em !important;
    }
  `;
  document.head.appendChild(style);

  if (overlayColor) {
    removeDyslexiaOverlay();
    const ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    Object.assign(ov.style, {
      position:      'fixed',
      inset:         '0',
      background:    overlayColor,
      pointerEvents: 'none',
      zIndex:        '2147483637',
      mixBlendMode:  'multiply',
    });
    document.body.appendChild(ov);
  }
}

export function removeDyslexiaCSS() {
  document.getElementById(CSS_ID)?.remove();
  removeDyslexiaOverlay();
}

function removeDyslexiaOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
}

// ── Classifier threshold patch ────────────────────────────────────────────────
// Returns a modified feature set with regression_rate damped for dyslexic readers,
// preventing the classifier from misreading their naturally high re-reading rate
// as confusion when they're actually reading normally.
export function patchFeaturesForDyslexia(features) {
  if (!features) return features;
  return {
    ...features,
    // Dyslexic readers routinely re-read 30-40% of saccades — treat up to 0.35
    // as their baseline and scale down toward the classifier's "normal" range.
    regression_rate:   Math.max(0, features.regression_rate - 0.20),
    // Slightly longer fixations are also normal — soften the signal.
    avg_fixation_ms:   features.avg_fixation_ms * 0.82,
  };
}
