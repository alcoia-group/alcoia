/* tts-handler.js
   Text-to-speech using the Web Speech API (no dependencies, works offline).
   - Speaks a paragraph aloud when confused/overloaded is triggered
   - Fires word-boundary callbacks so the caller can highlight each word in sync
   - Cancels automatically when a new speech request comes in
*/

export function createTTSHandler() {
  let activeUtterance = null;
  let activeHighlightCleanup = null;

  function isSupported() {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  function stop() {
    if (!isSupported()) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    activeUtterance = null;
    if (activeHighlightCleanup) { activeHighlightCleanup(); activeHighlightCleanup = null; }
  }

  function isSpeaking() {
    try { return window.speechSynthesis.speaking; } catch (e) { return false; }
  }

  // Highlight words inside an element in sync with TTS word boundaries.
  // Returns a cleanup fn to remove highlights.
  function buildWordHighlighter(el, text) {
    if (!el) return { onWord: null, cleanup: () => {} };

    // Wrap each word in a span so we can style it
    const original = el.innerHTML;
    const words    = text.split(/(\s+)/);
    let   idx      = 0;
    const spans    = [];

    el.innerHTML = words.map(chunk => {
      if (!chunk.trim()) return chunk;
      const id = `sra-tts-w-${idx++}`;
      spans.push(id);
      return `<span id="${id}" class="sra-tts-word">${chunk}</span>`;
    }).join('');

    let lastSpan = null;

    function onWord(charIndex) {
      // Map char index → word index by accumulating lengths
      let acc = 0, wordIdx = 0;
      for (let i = 0; i < words.length; i++) {
        if (!words[i].trim()) { acc += words[i].length; continue; }
        if (acc >= charIndex) break;
        acc += words[i].length;
        wordIdx++;
      }
      if (lastSpan) lastSpan.classList.remove('sra-tts-active');
      const spanId = spans[Math.min(wordIdx, spans.length - 1)];
      lastSpan = document.getElementById(spanId);
      if (lastSpan) lastSpan.classList.add('sra-tts-active');
    }

    function cleanup() {
      try { el.innerHTML = original; } catch (e) {}
    }

    return { onWord, cleanup };
  }

  // Speak text. opts: { el, rate, lang, onEnd }
  // el: optional DOM element — if provided, words are highlighted word-by-word
  function speak(text, opts = {}) {
    if (!isSupported()) return false;
    stop();

    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return false;

    const utt  = new SpeechSynthesisUtterance(clean);
    utt.rate   = opts.rate  || 0.88;
    utt.pitch  = opts.pitch || 1.0;
    utt.lang   = opts.lang  || document.documentElement.lang || 'en-US';

    let highlighter = { onWord: null, cleanup: () => {} };
    if (opts.el) {
      highlighter = buildWordHighlighter(opts.el, clean);
      activeHighlightCleanup = highlighter.cleanup;
    }

    if (highlighter.onWord) {
      utt.addEventListener('boundary', (e) => {
        if (e.name === 'word') highlighter.onWord(e.charIndex);
      });
    }

    utt.addEventListener('end',   () => { highlighter.cleanup(); activeUtterance = null; opts.onEnd && opts.onEnd(); });
    utt.addEventListener('error', () => { highlighter.cleanup(); activeUtterance = null; });

    activeUtterance = utt;
    // Chrome bug: speech synthesis sometimes silently stalls on long texts.
    // Splitting into sentences and queuing them avoids this.
    const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
    sentences.forEach((s, i) => {
      const u = i === 0 ? utt : new SpeechSynthesisUtterance(s.trim());
      if (i > 0) { u.rate = utt.rate; u.pitch = utt.pitch; u.lang = utt.lang; }
      window.speechSynthesis.speak(i === 0 ? utt : u);
    });

    return true;
  }

  return { speak, stop, isSpeaking, isSupported };
}

// Inject TTS word-highlight styles once
if (!document.getElementById('sra-tts-styles')) {
  const s = document.createElement('style');
  s.id = 'sra-tts-styles';
  s.textContent = `
    .sra-tts-word { transition: background 0.1s, color 0.1s; border-radius: 3px; }
    .sra-tts-active {
      background: rgba(26, 126, 93, 0.22) !important;
      color: #0f5c42 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(s);
}
