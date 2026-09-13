/* reading-calibration.js
 *
 * Measures a reader's words-per-minute baseline: a passage of known word
 * count is shown, the reader reads it at their own pace and says when they
 * are done, and words ÷ minutes is the WPM. That number seeds
 * comprehension-monitor.js's pace-vs-difficulty judgement.
 *
 * This used to have a second mode that paced the reader through the passage
 * word-by-word to generate WebGazer training points as a side effect — see
 * CLAUDE.md's migration note on removing the gaze path. That mode is gone.
 * Everything below is the self-paced measurement, which needs no sensor and
 * was always the number this feature was actually for.
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

/* Two things this deliberately does not do:
 *
 *   - It does not pace the reader. A word-by-word highlight would measure the
 *     highlight's speed, not the reader's.
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
      background: 'var(--alc-paper, #F9F7F2)',
      color: 'var(--alc-text, #333333)',
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
      textTransform: 'uppercase', color: 'var(--alc-accent, #5F4589)',
      marginBottom: '8px',
    });

    const intro = document.createElement('p');
    intro.textContent =
      'Read this at your normal article-reading pace. '
      + 'Press the button the moment you finish the last word.';
    Object.assign(intro.style, {
      fontSize: '13.5px', lineHeight: '1.6', margin: '0 0 20px',
      color: 'var(--alc-muted, #6B6862)',
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
      background: 'var(--alc-accent, #5F4589)', color: '#fff', cursor: 'pointer',
      fontFamily: 'var(--alc-ui, system-ui, sans-serif)',
      fontSize: '13px', fontWeight: '600', minHeight: '44px',
    });

    const skip = document.createElement('button');
    skip.textContent = 'Skip';
    Object.assign(skip.style, {
      padding: '11px 16px', borderRadius: '10px',
      border: '1px solid var(--alc-border, rgba(60,48,32,0.11))',
      background: 'transparent', color: 'var(--alc-muted, #6B6862)',
      cursor: 'pointer', fontFamily: 'var(--alc-ui, system-ui, sans-serif)',
      fontSize: '13px', fontWeight: '600', minHeight: '44px',
    });

    const status = document.createElement('div');
    Object.assign(status.style, {
      fontFamily: 'var(--alc-ui, system-ui, sans-serif)',
      fontSize: '12px', lineHeight: '1.5', marginTop: '12px', minHeight: '1.4em',
      color: 'var(--alc-muted, #6B6862)',
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
