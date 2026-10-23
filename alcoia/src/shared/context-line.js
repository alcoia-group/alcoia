/* context-line.js — the one short sentence a card may show about WHICH part of the reading it is about.
 *
 * Shown only on cards about something other than the paragraph in view or just read: a scheduled review of an
 * earlier paragraph, a delayed transfer check, a return check after an absence, and a probe about an earlier
 * paragraph. Never on questions, explanations or repairs about the paragraph just read. It is a statement about
 * the material, never a card type name. Built in the browser from text the page already has; never sent anywhere. */

export const CONTEXT_WORDS = 8;
const MAX_WORD_CHARS = 30;
export const CONTEXT_FALLBACK = 'You read this earlier.';

export function contextLineFor(text) {
  const words = typeof text === 'string' ? text.split(/\s+/).filter(Boolean) : [];
  if (!words.length) return CONTEXT_FALLBACK;
  const head = words.slice(0, CONTEXT_WORDS).map((w) => (w.length > MAX_WORD_CHARS ? w.slice(0, MAX_WORD_CHARS) : w));
  let start = head.join(' ').replace(/[\s,;:]+$/, '');
  if (!start) return CONTEXT_FALLBACK;
  if (words.length > CONTEXT_WORDS) start += '...';
  return `About the part that starts: "${start}"`;
}
