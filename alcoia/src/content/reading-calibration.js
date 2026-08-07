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

  /* No camera — the normal case. The gaze flow above exists to train
   * WebGazer, but the number this whole feature is actually for is the
   * reader's words-per-minute baseline, and that is measurable without any
   * sensor at all: show a passage of known length, let them read it, ask
   * when they are done. Bailing out here used to mean a reader with the
   * camera off had no way to set a baseline, so `comprehension-monitor.js`
   * had to learn one slowly from their browsing — which is exactly the
   * period during which its pace judgements are worst. */
  if (!available) {
    return runSelfPacedCalibration({ textIndex, onComplete });
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
      fontFamily:   'var(--alc-serif, Georgia, serif)',
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

    // Show WebGazer's camera feedback so the user can confirm face detection
    try { window.postMessage({ source: 'sra-control', type: 'setFeedback', enabled: true }, '*'); } catch (e) {}

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

    let animFrame  = null;
    let stopped    = false;
    let startedAt  = null;  // wall-clock time when highlighting begins

    function cleanup(success) {
      stopped = true;
      cancelAnimationFrame(animFrame);
      overlay.style.opacity = '0';
      try { window.postMessage({ source: 'sra-control', type: 'setFeedback', enabled: false }, '*'); } catch (e) {}

      // Compute WPM from actual elapsed time during the highlight loop
      let wpm = null;
      if (success && startedAt) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        wpm = elapsedSec > 0 ? Math.round((words.length / elapsedSec) * 60) : null;
      }

      setTimeout(() => {
        try { overlay.remove(); } catch(e) {}
        onComplete(success, wpm);
        resolve({ success, wpm });
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

      startedAt = Date.now();
      animFrame = requestAnimationFrame(step);
    }, 2000);
  });
}

/* ── Self-paced calibration — no camera, no permission ──────────────────────
 *
 * The reader reads a passage of known word count at their own pace and says
 * when they are done. Words ÷ minutes is their WPM. That is the entire
 * measurement, and it is the same one the gaze flow above derives as a
 * side effect — the difference is only that this one asks instead of watching.
 *
 * Two things it deliberately does not do:
 *
 *   - It does not pace the reader. The word-by-word highlight in the gaze
 *     flow exists to generate training points at known screen positions; as
 *     a way of measuring reading speed it measures the highlight's speed,
 *     not the reader's.
 *   - It does not silently discard an implausible result. Under ~70 or over
 *     ~1200 wpm means they skimmed it, got interrupted, or clicked early, so
 *     it says so and offers a retry rather than seeding a baseline that will
 *     mis-judge every paragraph they read afterwards.
 */
export function runSelfPacedCalibration(opts = {}) {
  const textIndex  = opts.textIndex ?? Math.floor(Math.random() * CALIBRATION_TEXTS.length);
  const onComplete = opts.onComplete || (() => {});
  const MIN_WPM = 70;
  const MAX_WPM = 1200;

  const rawText = CALIBRATION_TEXTS[textIndex];
  const words   = rawText.trim().split(/\s+/).filter((w) => w.length > 0);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'sra-cal-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646',
      background: 'rgba(20,24,22,0.72)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px', opacity: '0', transition: 'opacity 0.25s',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      boxSizing: 'border-box',
      background: 'var(--alc-paper, #FCFAF5)',
      color: 'var(--alc-text, #2A2722)',
      borderRadius: '16px', padding: '28px 32px',
      maxWidth: '620px', width: '100%', maxHeight: '86vh', overflowY: 'auto',
      fontFamily: 'var(--alc-serif, Georgia, serif)',
      boxShadow: '0 20px 60px rgba(20,24,22,0.4)',
    });

    const label = document.createElement('div');
    label.textContent = 'Reading speed';
    Object.assign(label.style, {
      fontFamily: 'var(--alc-ui, system-ui, sans-serif)',
      fontSize: '10.5px', fontWeight: '700', letterSpacing: '0.09em',
      textTransform: 'uppercase', color: 'var(--alc-accent, #1A7E5D)',
      marginBottom: '8px',
    });

    const intro = document.createElement('p');
    intro.textContent =
      'Read this at the pace you would normally read an article — not faster. '
      + 'Press the button the moment you finish the last word.';
    Object.assign(intro.style, {
      fontSize: '13.5px', lineHeight: '1.6', margin: '0 0 20px',
      color: 'var(--alc-muted, #6E675C)',
    });

    const passage = document.createElement('div');
    passage.textContent = rawText.replace(/\s+/g, ' ').trim();
    Object.assign(passage.style, {
      fontSize: '17px', lineHeight: '1.85', margin: '0 0 22px',
      filter: 'blur(5px)', userSelect: 'none',
      transition: 'filter 0.25s',
    });

    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '8px', alignItems: 'center' });

    const primary = document.createElement('button');
    primary.textContent = 'Start reading';
    Object.assign(primary.style, {
      flex: '1', padding: '11px 16px', borderRadius: '10px', border: 'none',
      background: 'var(--alc-accent, #1A7E5D)', color: '#fff', cursor: 'pointer',
      fontFamily: 'var(--alc-ui, system-ui, sans-serif)',
      fontSize: '13px', fontWeight: '600', minHeight: '44px',
    });

    const skip = document.createElement('button');
    skip.textContent = 'Skip';
    Object.assign(skip.style, {
      padding: '11px 16px', borderRadius: '10px',
      border: '1px solid var(--alc-border, rgba(60,48,32,0.11))',
      background: 'transparent', color: 'var(--alc-muted, #6E675C)',
      cursor: 'pointer', fontFamily: 'var(--alc-ui, system-ui, sans-serif)',
      fontSize: '13px', fontWeight: '600', minHeight: '44px',
    });

    const status = document.createElement('div');
    Object.assign(status.style, {
      fontFamily: 'var(--alc-ui, system-ui, sans-serif)',
      fontSize: '12px', lineHeight: '1.5', marginTop: '12px', minHeight: '1.4em',
      color: 'var(--alc-muted, #6E675C)',
    });
    status.textContent = `${words.length} words. The text is blurred until you start.`;

    actions.append(primary, skip);
    panel.append(label, intro, passage, actions, status);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.opacity = '1'; }));

    let startedAt = null;

    function finish(success, wpm) {
      document.removeEventListener('keydown', onKey, true);
      overlay.style.opacity = '0';
      setTimeout(() => {
        try { overlay.remove(); } catch (e) { /* already gone */ }
        onComplete(success, wpm);
        resolve({ success, wpm });
      }, 280);
    }

    function begin() {
      startedAt = Date.now();
      passage.style.filter = 'none';
      primary.textContent = "I've finished";
      status.textContent = 'Press when you reach the end of the last sentence.';
    }

    function stop() {
      const mins = (Date.now() - startedAt) / 60000;
      const wpm  = mins > 0 ? Math.round(words.length / mins) : null;

      if (!wpm || wpm < MIN_WPM || wpm > MAX_WPM) {
        // Say which way it went wrong — "try again" alone tells them nothing.
        status.textContent = wpm && wpm > MAX_WPM
          ? `That came out at ${wpm} wpm, which is faster than reading. Try again and read it properly.`
          : `That came out at ${wpm || 0} wpm, which is slower than reading. Try again without pausing.`;
        startedAt = null;
        passage.style.filter = 'blur(5px)';
        primary.textContent = 'Start reading';
        return;
      }
      status.textContent = `${wpm} words per minute. Saved.`;
      primary.disabled = true;
      setTimeout(() => finish(true, wpm), 900);
    }

    primary.addEventListener('click', () => (startedAt === null ? begin() : stop()));
    skip.addEventListener('click', () => finish(false, null));

    /* Space and Enter do what the button does, so a keyboard reader is not
     * forced to break their own timing by reaching for the mouse. */
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); finish(false, null); return; }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!primary.disabled) (startedAt === null ? begin() : stop());
      }
    }
    document.addEventListener('keydown', onKey, true);
  });
}