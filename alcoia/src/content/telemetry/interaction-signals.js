/* interaction-signals.js — selection, copy, and the blur/return signature
 *
 * Selection and copy are the highest-precision events available: the reader
 * did something deliberate. They are still only corroboration here, for two
 * reasons. People select text to quote, share and highlight, not only when
 * confused; and the extension already opens a summary on selection, so
 * treating it as its own interruption trigger would interrupt twice for one
 * action — the exact defect P1 fixed.
 *
 * Blur/return is the assertable one. Leaving for a while and coming back to
 * the same paragraph is a confirmed loss of the thread. Leaving and carrying
 * on forwards is an ordinary interruption and means nothing.
 */

import { countWords, detectLanguage } from './segmentation.js';

export const LONG_BLUR_MS = 30000;

export function createInteractionSignals(opts = {}) {
  const now             = opts.now || (() => Date.now());
  const longBlurMs      = opts.longBlurMs ?? LONG_BLUR_MS;
  const minSelectionLen = opts.minSelectionLength ?? 12;
  const cooldownMs      = opts.cooldown ?? 15000;

  let pending    = [];
  let blurAt     = null;
  let blurIndex  = null;
  let lastEmitAt = 0;
  let blurEvents = 0;
  let longBlurEvents = 0;

  function push(sig) {
    const t = now();
    if (t - lastEmitAt < cooldownMs && sig.assertable) return null;
    if (sig.assertable) lastEmitAt = t;
    pending.push(sig);
    return sig;
  }

  /* evt: { kind: 'selection'|'copy'|'blur'|'focus', text?, paragraphIndex? } */
  function update(evt) {
    if (!evt || !evt.kind) return null;

    if (evt.kind === 'selection') {
      const text = (evt.text || '').trim();
      if (text.length < minSelectionLen) return null;
      return push({
        type: 'selection', assertable: false,
        length: text.length, text: text.slice(0, 120),
      });
    }

    if (evt.kind === 'copy') {
      const text = (evt.text || '').trim();
      if (!text) return null;
      // A short copy is usually a term the reader intends to look up.
      return push({
        type: 'copy', assertable: false,
        length: text.length, text: text.slice(0, 120),
        // Whitespace counting called every CJK selection a single-word "term",
        // however much text was actually highlighted.
        subtype: countWords(text, detectLanguage()) <= 4 ? 'term' : 'passage',
      });
    }

    if (evt.kind === 'blur') {
      blurEvents += 1;
      blurAt = now();
      blurIndex = Number.isInteger(evt.paragraphIndex) ? evt.paragraphIndex : null;
      return null;
    }

    if (evt.kind === 'focus') {
      if (blurAt == null) return null;
      const blurMs = now() - blurAt;
      const wasAt  = blurIndex;
      blurAt = null; blurIndex = null;

      if (blurMs < longBlurMs) return null;      // a short interruption is just life
      longBlurEvents += 1;
      const backAt = Number.isInteger(evt.paragraphIndex) ? evt.paragraphIndex : null;
      // Only a return to the same paragraph says the thread was lost. Carrying
      // on forwards is not evidence of anything.
      if (wasAt == null || backAt == null || backAt !== wasAt) return null;

      return push({
        type: 'blur_return', assertable: true,
        subtype: 'resumed_same', blurMs, paragraphIndex: backAt,
      });
    }

    return null;
  }

  function signal() { const s = pending; pending = []; return s.length ? s : null; }

  const stats = () => ({ blurEvents, longBlurEvents });

  return { update, signal, stats, reset() { pending = []; blurAt = null; blurIndex = null; lastEmitAt = 0; } };
}
