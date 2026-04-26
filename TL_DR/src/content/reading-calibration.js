/* reading-calibration.js
   Expert calibration via natural reading.

   How it works:
   A short paragraph is displayed. Words are highlighted one by one at a
   controlled pace (~220ms per word — normal adult reading speed). For each
   highlighted word, its exact DOM bounding rect is recorded as a WebGazer
   training point via recordScreenPosition(). The user just reads; no clicking.

   Why this is better than dot-click calibration:
   - 80-100 training examples instead of 18
   - Examples are in the actual reading area, not abstract grid positions
   - WebGazer's ridge regression learns the mapping precisely where it matters
   - More natural — the user reads text rather than clicking targets

   Will it fix the debug dot?
   Significantly better than click calibration alone. The dot will be more
   accurate in the centre-left reading zone. The fundamental noise floor
   from the webcam sensor (~40-60px) cannot be eliminated by any calibration.

   Usage: import and call runReadingCalibration() before runCalibrationSequence().
   Or call it standalone as the only calibration method.
*/

const CALIBRATION_TEXTS = [
  `Researchers have found that the human eye does not read smoothly across a page.
   Instead it jumps from word to word in short rapid movements called saccades,
   pausing briefly on each word to extract meaning. These pauses are called fixations
   and typically last between one hundred and three hundred milliseconds. The brain
   processes the word during the fixation, not during the movement itself.`,

  `The ability to focus attention on a single task has become increasingly rare.
   Modern environments are filled with interruptions that pull the mind away from
   deep reading. Studies show that comprehension drops significantly when attention
   is divided, even when the reader believes they are following the text closely.
   The eyes may move correctly across the page while the mind processes nothing at all.`,

  `Complex technical writing presents a particular challenge for readers who are
   encountering unfamiliar terminology for the first time. The brain must simultaneously
   decode the visual symbols, parse the grammatical structure, and retrieve the meaning
   of each term from memory. When any one of these processes fails, regression occurs
   as the eye moves back to re-read the problematic section before continuing forward.`,
];

export async function runReadingCalibration(opts = {}) {
  const MS_PER_WORD    = opts.msPerWord    || 220;  // ~270 wpm, slightly slow for comfort
  const PAUSE_AT_END   = opts.pauseAtEnd   || 1200;
  const textIndex      = opts.textIndex    || Math.floor(Math.random() * CALIBRATION_TEXTS.length);
  const onComplete     = opts.onComplete   || (() => {});

  // Check WebGazer is available
  const available = await new Promise(resolve => {
    const id = 'cal-' + Math.random().toString(36).slice(2);
    const handler = ev => {
      if (!ev.data || ev.data.source !== 'sra-cal-pong' || ev.data.sra_ping_id !== id) return;
      window.removeEventListener('message', handler);
      resolve(ev.data.available);
    };
    window.addEventListener('message', handler);
    window.postMessage({ source: 'sra-cal-ping', sra_ping_id: id }, '*');
    setTimeout(() => { window.removeEventListener('message', handler); resolve(false); }, 1000);
  });

  if (!available) {
    console.warn('[TL;DR] Reading calibration: WebGazer not available');
    return false;
  }

  return new Promise(resolve => {
    // ── Build overlay ────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position:    'fixed',
      inset:       '0',
      background:  'rgba(12,12,14,0.92)',
      zIndex:      '2147483646',
      display:     'flex',
      alignItems:  'center',
      justifyContent: 'center',
      opacity:     '0',
      transition:  'opacity 0.3s',
      backdropFilter: 'blur(4px)',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background:   '#FAFAF7',
      borderRadius: '16px',
      padding:      '36px 44px',
      maxWidth:     '640px',
      width:        '90vw',
      fontFamily:   'Georgia, serif',
      boxShadow:    '0 24px 60px rgba(0,0,0,0.4)',
    });

    const title = document.createElement('div');
    title.textContent = 'Reading Calibration';
    Object.assign(title.style, {
      fontSize:     '13px',
      fontWeight:   '700',
      color:        '#1A7E5D',
      letterSpacing:'1px',
      textTransform:'uppercase',
      marginBottom: '6px',
    });

    const subtitle = document.createElement('div');
    subtitle.textContent = 'Read the highlighted text at your natural pace. No clicking needed.';
    Object.assign(subtitle.style, {
      fontSize: '13px', color: '#7a7a72', fontStyle: 'italic',
      marginBottom: '24px',
    });

    // Progress bar
    const progressWrap = document.createElement('div');
    Object.assign(progressWrap.style, {
      height: '3px', background: 'rgba(26,126,93,0.15)',
      borderRadius: '2px', marginBottom: '28px', overflow: 'hidden',
    });
    const progressFill = document.createElement('div');
    Object.assign(progressFill.style, {
      height: '100%', background: '#1A7E5D', width: '0%',
      borderRadius: '2px', transition: 'width 0.15s linear',
    });
    progressWrap.appendChild(progressFill);

    // Text container — words are injected here as <span> elements
    const textContainer = document.createElement('div');
    Object.assign(textContainer.style, {
      fontSize:    '18px',
      lineHeight:  '1.9',
      color:       '#2c2c2a',
      marginBottom:'28px',
    });

    const statusLine = document.createElement('div');
    Object.assign(statusLine.style, {
      fontSize: '11px', color: '#7a7a72', fontStyle: 'italic', textAlign: 'center',
    });
    statusLine.textContent = 'Starting in 2 seconds...';

    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'Skip calibration';
    Object.assign(skipBtn.style, {
      marginTop: '14px', display: 'block', background: 'none',
      border: 'none', color: '#7a7a72', fontFamily: 'Georgia, serif',
      fontSize: '11px', fontStyle: 'italic', cursor: 'pointer', padding: '0',
    });
    skipBtn.addEventListener('click', () => cleanup(false));

    panel.appendChild(title);
    panel.appendChild(subtitle);
    panel.appendChild(progressWrap);
    panel.appendChild(textContainer);
    panel.appendChild(statusLine);
    panel.appendChild(skipBtn);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.style.opacity = '1'));

    // ── Parse text into word spans ───────────────────────────────────────────
    const rawText = CALIBRATION_TEXTS[textIndex];
    const words   = rawText.trim().split(/\s+/).filter(w => w.length > 0);
    const spans   = [];

    words.forEach((word, i) => {
      const span = document.createElement('span');
      span.textContent = word + ' ';
      Object.assign(span.style, {
        display:       'inline',
        padding:       '1px 0',
        borderRadius:  '3px',
        transition:    'background 0.12s, color 0.12s',
        color:         '#aaa',
      });
      textContainer.appendChild(span);
      spans.push(span);
    });

    let animFrame = null;
    let stopped   = false;

    function cleanup(success) {
      stopped = true;
      cancelAnimationFrame(animFrame);
      overlay.style.opacity = '0';
      setTimeout(() => {
        try { overlay.remove(); } catch(e) {}
        onComplete(success);
        resolve(success);
      }, 320);
    }

    // ── Highlight loop ───────────────────────────────────────────────────────
    let wordIdx   = 0;
    let lastTime  = null;
    let recorded  = 0;

    // 2-second countdown before starting
    setTimeout(() => {
      if (stopped) return;
      statusLine.textContent = `Calibrating... (0 / ${words.length} words)`;

      function step(ts) {
        if (stopped) return;
        if (wordIdx >= words.length) {
          // All words done — finish after a pause
          setTimeout(() => cleanup(true), PAUSE_AT_END);
          return;
        }

        if (!lastTime) lastTime = ts;
        const elapsed = ts - lastTime;

        if (elapsed >= MS_PER_WORD) {
          lastTime = ts;

          // Unhighlight previous
          if (wordIdx > 0) {
            Object.assign(spans[wordIdx - 1].style, {
              background: 'transparent',
              color:      '#2c2c2a',
              fontWeight: 'normal',
            });
          }

          // Highlight current
          const span = spans[wordIdx];
          Object.assign(span.style, {
            background: 'rgba(26,126,93,0.18)',
            color:      '#0f5c42',
            fontWeight: '700',
          });

          // Record this word's position as a WebGazer training point
          // We use the centre of the highlighted word's bounding rect
          requestAnimationFrame(() => {
            if (stopped) return;
            const rect = span.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const cx = rect.left + rect.width  / 2;
              const cy = rect.top  + rect.height / 2;
              window.postMessage({ source: 'sra-cal-record', x: cx, y: cy }, '*');
              recorded++;
            }
          });

          wordIdx++;
          progressFill.style.width = ((wordIdx / words.length) * 100) + '%';
          statusLine.textContent   = `Calibrating... (${wordIdx} / ${words.length} words)`;
        }

        animFrame = requestAnimationFrame(step);
      }

      animFrame = requestAnimationFrame(step);
    }, 2000);
  });
}