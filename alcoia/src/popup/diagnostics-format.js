/* diagnostics-format.js — pure formatting helpers for diagnostics.js
 *
 * Split out from diagnostics.js because these are the parts worth pinning
 * with a test: this page is explicitly required to be safe to screenshot,
 * and maskToken() is the function standing between that requirement and a
 * bearer credential rendered in full. No DOM, no chrome.* calls — nothing
 * here needs a browser to test.
 */

/* Only the last few characters ever render. The token identifies an
 * install rather than a person (the project notes, access control) but is still a
 * bearer credential — showing it in full on a page meant to be
 * screenshotted would hand it to whoever the screenshot reaches. */
export function maskToken(token) {
  if (!token || typeof token !== 'string') return '—';
  if (token.length <= 4) return '••••';
  return '•'.repeat(Math.min(token.length - 4, 12)) + token.slice(-4);
}

export function relativeTime(at, now = Date.now()) {
  const s = Math.round((now - at) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
